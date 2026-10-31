import { matchmakingKeys, type MatchPool, type Redis } from '@app/redis';
import { type ChatMode, type SupportedLang } from '@app/shared';
import { type Result } from 'ioredis';
import { z } from 'zod';

import { CANCEL_TICKET, DROP_TICKETS_IF_UNCHANGED, ENQUEUE_OR_MATCH } from './lua.ts';
import { type NewTicket, type Ticket, ticketSchema } from './ticket.ts';

declare module 'ioredis' {
  // Custom commands registered with defineCommand (ioredis' documented typing pattern).
  interface RedisCommander<Context> {
    mmEnqueueOrMatch(numKeys: number, ...args: (string | number)[]): Result<unknown, Context>;
    mmCancelTicket(ticketsKey: string, ticketId: string): Result<unknown, Context>;
    mmDropTickets(ticketsKey: string, ...args: string[]): Result<unknown, Context>;
  }
}

export interface MatchDimensions {
  pool: MatchPool;
  mode: ChatMode;
  lang: SupportedLang;
}

export type Phase = 'interest' | 'any';

export type EnqueueResult =
  | { status: 'waiting' }
  | { status: 'not_waiting' }
  | { status: 'matched'; peer: Ticket; commonInterests: string[] };

export type CancelResult =
  { status: 'cancelled' } | { status: 'not_found' } | { status: 'matched'; sessionId: string };

export interface MatchmakerOptions {
  /** A matched pair won't be matched again for this long. */
  recentPairTtlMs: number;
  /** Max queue entries inspected per queue per call (bounded work under load). */
  maxScan?: number;
}

const rawEnqueueResult = z.union([
  z.tuple([z.enum(['waiting', 'duplicate', 'not_waiting'])]),
  z.tuple([z.literal('matched'), z.string()]).rest(z.string()),
]);
const rawCancelResult = z.union([
  z.tuple([z.enum(['cancelled', 'not_found'])]),
  z.tuple([z.literal('matched'), z.string()]),
]);

const registered = new WeakSet<Redis>();

function ensureCommands(redis: Redis): void {
  if (registered.has(redis)) return;
  redis.defineCommand('mmEnqueueOrMatch', { lua: ENQUEUE_OR_MATCH });
  redis.defineCommand('mmCancelTicket', { numberOfKeys: 1, lua: CANCEL_TICKET });
  redis.defineCommand('mmDropTickets', { numberOfKeys: 1, lua: DROP_TICKETS_IF_UNCHANGED });
  registered.add(redis);
}

function parseTicket(raw: string): Ticket {
  return ticketSchema.parse(JSON.parse(raw));
}

export function createMatchmaker(redis: Redis, options: MatchmakerOptions) {
  ensureCommands(redis);
  const maxScan = options.maxScan ?? 50;

  async function run(
    dims: MatchDimensions,
    ticket: NewTicket | Ticket,
    phase: Phase,
    op: 'enqueue' | 'promote',
    sessionId: string,
    now: number,
  ): Promise<EnqueueResult> {
    const keys = matchmakingKeys(dims.pool, dims.mode, dims.lang);
    const interestQueues = ticket.interests.map((interest) => keys.queueInterest(interest));
    const ticketJson = JSON.stringify(
      ticketSchema.parse({ ...ticket, status: 'waiting', sessionId: undefined }),
    );
    const raw = await redis.mmEnqueueOrMatch(
      3 + interestQueues.length,
      keys.tickets,
      keys.recent,
      keys.queueAny,
      ...interestQueues,
      ticketJson,
      ticket.ticketId,
      ticket.visitorId,
      phase,
      now,
      options.recentPairTtlMs,
      maxScan,
      sessionId,
      op,
    );
    const result = rawEnqueueResult.parse(raw);
    if (result[0] === 'matched') {
      const [, peerJson, ...commonInterests] = result;
      return { status: 'matched', peer: parseTicket(peerJson), commonInterests };
    }
    if (result[0] === 'duplicate') throw new Error(`Ticket ${ticket.ticketId} already exists`);
    return { status: result[0] };
  }

  return {
    /**
     * Atomically matches the ticket against waiting tickets (interest queues for phase
     * 'interest', `q:any` for 'any') or enqueues it. `sessionId` is recorded on both tickets
     * if they match, so a concurrent cancel can tell which session the visitor ended up in.
     */
    enqueueOrMatch(
      dims: MatchDimensions,
      ticket: NewTicket,
      phase: Phase,
      sessionId: string,
      now: number = Date.now(),
    ): Promise<EnqueueResult> {
      return run(dims, ticket, phase, 'enqueue', sessionId, now);
    },

    /** Interest fallback: scans `q:any` for a still-waiting ticket, else joins `q:any`. */
    async promoteToAny(
      dims: MatchDimensions,
      ticketId: string,
      sessionId: string,
      now: number = Date.now(),
    ): Promise<EnqueueResult> {
      const ticket = await this.getTicket(dims, ticketId);
      if (ticket === null) return { status: 'not_waiting' };
      // Interest queues are irrelevant in phase 'any'; the script re-reads the stored ticket.
      return run(dims, { ...ticket, interests: [] }, 'any', 'promote', sessionId, now);
    },

    async cancelTicket(dims: MatchDimensions, ticketId: string): Promise<CancelResult> {
      const keys = matchmakingKeys(dims.pool, dims.mode, dims.lang);
      const result = rawCancelResult.parse(await redis.mmCancelTicket(keys.tickets, ticketId));
      if (result[0] === 'matched') return { status: 'matched', sessionId: result[1] };
      return { status: result[0] };
    },

    async getTicket(dims: MatchDimensions, ticketId: string): Promise<Ticket | null> {
      const keys = matchmakingKeys(dims.pool, dims.mode, dims.lang);
      const raw = await redis.hget(keys.tickets, ticketId);
      return raw === null ? null : parseTicket(raw);
    },

    /**
     * Deletes stale tickets of one pool/mode/lang: settled (matched/cancelled) tickets older
     * than `settledAgeMs`, and waiting tickets older than `maxWaitingAgeMs` or owned by a dead
     * gateway node. Queue references to deleted tickets are dropped lazily by later scans.
     * Returns the number of tickets deleted.
     */
    async sweepStale(
      dims: MatchDimensions,
      opts: {
        now?: number;
        maxWaitingAgeMs: number;
        settledAgeMs?: number;
        isNodeAlive?: (nodeId: string) => Promise<boolean>;
      },
    ): Promise<number> {
      const now = opts.now ?? Date.now();
      const settledAgeMs = opts.settledAgeMs ?? 120_000;
      const keys = matchmakingKeys(dims.pool, dims.mode, dims.lang);
      const nodeAlive = new Map<string, boolean>();
      let cursor = '0';
      let dropped = 0;

      do {
        const [next, flat] = await redis.hscan(keys.tickets, cursor, 'COUNT', 200);
        cursor = next;
        const doomed: string[] = [];
        for (let i = 0; i + 1 < flat.length; i += 2) {
          const ticketId = flat[i] ?? '';
          const raw = flat[i + 1] ?? '';
          let stale: boolean;
          try {
            const ticket = parseTicket(raw);
            const age = now - ticket.createdAt;
            if (ticket.status !== 'waiting') {
              stale = age > settledAgeMs;
            } else if (age > opts.maxWaitingAgeMs) {
              stale = true;
            } else if (ticket.nodeId !== undefined && opts.isNodeAlive !== undefined) {
              let alive = nodeAlive.get(ticket.nodeId);
              if (alive === undefined) {
                alive = await opts.isNodeAlive(ticket.nodeId);
                nodeAlive.set(ticket.nodeId, alive);
              }
              stale = !alive;
            } else {
              stale = false;
            }
          } catch {
            stale = true; // unparsable entry
          }
          if (stale) doomed.push(ticketId, raw);
        }
        if (doomed.length > 0) {
          dropped += z.number().parse(await redis.mmDropTickets(keys.tickets, ...doomed));
        }
      } while (cursor !== '0');

      return dropped;
    },
  };
}

export type Matchmaker = ReturnType<typeof createMatchmaker>;
