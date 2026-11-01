import { randomInt } from 'node:crypto';

import { matchmakingKeys, type QueueBucket, type QueueFamily, type Redis } from '@app/redis';
import { type Result } from 'ioredis';
import { z } from 'zod';

import {
  CANCEL_SEEK,
  CANCEL_TICKET,
  DROP_TICKETS_IF_UNCHANGED,
  ENQUEUE_OR_MATCH,
  FINISH_SEEK,
  SEEK_OR_MATCH,
} from './lua.ts';
import { type NewTicket, type Seek, seekSchema, type Ticket, ticketSchema } from './ticket.ts';

declare module 'ioredis' {
  // Custom commands registered with defineCommand (ioredis' documented typing pattern).
  interface RedisCommander<Context> {
    mmEnqueueOrMatch(numKeys: number, ...args: (string | number)[]): Result<unknown, Context>;
    mmSeekOrMatch(...args: (string | number)[]): Result<unknown, Context>;
    mmCancelSeek(seeksKey: string, seekQueue: string, sessionId: string, seekId: string): Result<unknown, Context>;
    mmFinishSeek(seeksKey: string, sessionId: string, seekId: string): Result<unknown, Context>;
    mmCancelTicket(ticketsKey: string, ticketId: string): Result<unknown, Context>;
    mmDropTickets(ticketsKey: string, ...args: string[]): Result<unknown, Context>;
  }
}

export type Phase = 'interest' | 'any';

export type EnqueueResult =
  | { status: 'waiting' }
  | { status: 'not_waiting' }
  | { status: 'matched'; peer: Ticket; commonInterests: string[] }
  /** A group ticket joined a seeking session (Part 12); the ticket is matched to it. */
  | { status: 'joined'; seek: Seek };

export type SeekResult = { status: 'seeking' } | { status: 'joined'; joiner: Ticket };

export type CancelSeekResult =
  { status: 'cancelled' | 'not_found' } | { status: 'filled'; joinerVisitorId: string };

export type NewSeek = Pick<Seek, 'sessionId' | 'seekId' | 'visitorIds' | 'createdAt'>;

export type CancelResult =
  { status: 'cancelled' } | { status: 'not_found' } | { status: 'matched'; sessionId: string };

export type HopResult = { status: 'not_waiting' } | (EnqueueResult & { bucket: number });

export interface MatchmakerOptions {
  /** A matched pair won't be matched again for this long (within one bucket). */
  recentPairTtlMs: number;
  /** Max queue entries inspected per queue per call (bounded work under load). */
  maxScan?: number;
}

export interface EnqueueOptions {
  now?: number;
  /** Push to the head of the queues (fair requeue, bucket hop). */
  priority?: boolean;
}

const rawEnqueueResult = z.union([
  z.tuple([z.enum(['waiting', 'duplicate', 'not_waiting'])]),
  z.tuple([z.literal('joined'), z.string()]),
  z.tuple([z.literal('matched'), z.string()]).rest(z.string()),
]);
const rawSeekResult = z.union([
  z.tuple([z.literal('seeking')]),
  z.tuple([z.literal('joined'), z.string()]),
]);
const rawCancelSeekResult = z.union([
  z.tuple([z.enum(['cancelled', 'not_found'])]),
  z.tuple([z.literal('filled'), z.string()]),
]);
const rawCancelResult = z.union([
  z.tuple([z.enum(['cancelled', 'not_found'])]),
  z.tuple([z.literal('matched'), z.string()]),
]);

const registered = new WeakSet<Redis>();

function ensureCommands(redis: Redis): void {
  if (registered.has(redis)) return;
  redis.defineCommand('mmEnqueueOrMatch', { lua: ENQUEUE_OR_MATCH });
  redis.defineCommand('mmSeekOrMatch', { numberOfKeys: 5, lua: SEEK_OR_MATCH });
  redis.defineCommand('mmCancelSeek', { numberOfKeys: 2, lua: CANCEL_SEEK });
  redis.defineCommand('mmFinishSeek', { numberOfKeys: 1, lua: FINISH_SEEK });
  redis.defineCommand('mmCancelTicket', { numberOfKeys: 1, lua: CANCEL_TICKET });
  redis.defineCommand('mmDropTickets', { numberOfKeys: 1, lua: DROP_TICKETS_IF_UNCHANGED });
  registered.add(redis);
}

function parseTicket(raw: string): Ticket {
  return ticketSchema.parse(JSON.parse(raw));
}

/**
 * Buckets sampled per choice. The master design says 2; with few buckets and sparse queues,
 * 2 random picks out of 4 miss the only bucket with a waiter half the time (D-056). Sampling
 * up to 4 costs the same single round trip and still spreads load across 32–64 buckets.
 */
export const BUCKET_CHOICES = 4;

/** Up to BUCKET_CHOICES distinct random buckets (all of them if there are fewer). */
function candidates(bucketCount: number, exclude?: number): number[] {
  const pool = Array.from({ length: bucketCount }, (_, i) => i).filter((b) => b !== exclude);
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = randomInt(0, i + 1);
    [pool[i], pool[j]] = [pool[j] ?? 0, pool[i] ?? 0];
  }
  return pool.slice(0, BUCKET_CHOICES);
}

export function createMatchmaker(redis: Redis, options: MatchmakerOptions) {
  ensureCommands(redis);
  const maxScan = options.maxScan ?? 50;

  async function run(
    dims: QueueBucket,
    ticket: NewTicket | Ticket,
    phase: Phase,
    op: 'enqueue' | 'promote',
    sessionId: string,
    { now = Date.now(), priority = false }: EnqueueOptions,
  ): Promise<EnqueueResult> {
    const keys = matchmakingKeys(dims);
    const interestQueues =
      phase === 'interest' ? ticket.interests.map((interest) => keys.queueInterest(interest)) : [];
    const ticketJson = JSON.stringify(
      ticketSchema.parse({ ...ticket, status: 'waiting', phase, sessionId: undefined }),
    );
    const raw = await redis.mmEnqueueOrMatch(
      5 + interestQueues.length,
      keys.tickets,
      keys.recent,
      keys.queueAny,
      keys.queueSeek,
      keys.seeks,
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
      priority ? '1' : '0',
    );
    const result = rawEnqueueResult.parse(raw);
    if (result[0] === 'joined') {
      return { status: 'joined', seek: seekSchema.parse(JSON.parse(result[1])) };
    }
    if (result[0] === 'matched') {
      const [, peerJson, ...commonInterests] = result;
      return { status: 'matched', peer: parseTicket(peerJson), commonInterests };
    }
    if (result[0] === 'duplicate') throw new Error(`Ticket ${ticket.ticketId} already exists`);
    return { status: result[0] };
  }

  async function getTicket(dims: QueueBucket, ticketId: string): Promise<Ticket | null> {
    const raw = await redis.hget(matchmakingKeys(dims).tickets, ticketId);
    return raw === null ? null : parseTicket(raw);
  }

  async function cancelTicket(dims: QueueBucket, ticketId: string): Promise<CancelResult> {
    const keys = matchmakingKeys(dims);
    const result = rawCancelResult.parse(await redis.mmCancelTicket(keys.tickets, ticketId));
    if (result[0] === 'matched') return { status: 'matched', sessionId: result[1] };
    return { status: result[0] };
  }

  /**
   * "Power of d choices" (d = BUCKET_CHOICES): look at a few random buckets in one pipelined
   * round trip; prefer the one with the most people waiting in the ticket's queues (an instant
   * match is likely), else any (all empty). Queue lengths include not-yet-dropped dead refs; it
   * is a heuristic, not an exact count.
   */
  async function chooseBucket(
    family: QueueFamily,
    bucketCount: number,
    interests: string[],
    { exclude }: { exclude?: number } = {},
  ): Promise<number> {
    const picks = candidates(bucketCount, exclude);
    if (picks.length === 0) return exclude ?? 0;
    if (picks.length === 1) return picks[0] ?? 0;

    const pipeline = redis.pipeline();
    for (const bucket of picks) {
      const keys = matchmakingKeys({ ...family, bucket });
      pipeline.llen(keys.queueAny);
      for (const interest of interests) pipeline.llen(keys.queueInterest(interest));
    }
    const lengths = ((await pipeline.exec()) ?? []).map(([, value]) =>
      typeof value === 'number' ? value : 0,
    );
    const perBucket = interests.length + 1;
    let best = picks[0] ?? 0;
    let bestWaiting = -1;
    picks.forEach((bucket, index) => {
      const waiting = lengths
        .slice(index * perBucket, (index + 1) * perBucket)
        .reduce((sum, n) => sum + n, 0);
      if (waiting > bestWaiting) {
        best = bucket;
        bestWaiting = waiting;
      }
    });
    return best; // picks are shuffled, so ties (e.g. all empty) resolve randomly
  }

  return {
    chooseBucket,
    getTicket,
    cancelTicket,

    /**
     * A session starts seeking one more person in bucket `dims` (Part 12): a waiting group
     * ticket in `q:any` joins at once, else the seek waits in `q:seek` for the next one.
     */
    async seekOrMatch(
      dims: QueueBucket,
      seek: NewSeek,
      { now = Date.now() }: { now?: number } = {},
    ): Promise<SeekResult> {
      const keys = matchmakingKeys(dims);
      const seekJson = JSON.stringify(seekSchema.parse({ ...seek, status: 'seeking' }));
      const result = rawSeekResult.parse(
        await redis.mmSeekOrMatch(
          keys.tickets,
          keys.recent,
          keys.queueAny,
          keys.queueSeek,
          keys.seeks,
          seekJson,
          seek.sessionId,
          now,
          options.recentPairTtlMs,
          maxScan,
        ),
      );
      return result[0] === 'joined'
        ? { status: 'joined', joiner: parseTicket(result[1]) }
        : { status: 'seeking' };
    },

    /** Ends a seek round; a filled one is reported, not removed (its joiner is being added). */
    async cancelSeek(dims: QueueBucket, sessionId: string, seekId: string): Promise<CancelSeekResult> {
      const keys = matchmakingKeys(dims);
      const result = rawCancelSeekResult.parse(
        await redis.mmCancelSeek(keys.seeks, keys.queueSeek, sessionId, seekId),
      );
      return result[0] === 'filled'
        ? { status: 'filled', joinerVisitorId: result[1] }
        : { status: result[0] };
    },

    /** Deletes a filled seek after its joiner was added (or turned away). */
    async finishSeek(dims: QueueBucket, sessionId: string, seekId: string): Promise<void> {
      await redis.mmFinishSeek(matchmakingKeys(dims).seeks, sessionId, seekId);
    },

    async getSeek(dims: QueueBucket, sessionId: string): Promise<Seek | null> {
      const raw = await redis.hget(matchmakingKeys(dims).seeks, sessionId);
      return raw === null ? null : seekSchema.parse(JSON.parse(raw));
    },

    /**
     * Atomically matches the ticket against waiting tickets of its bucket (interest queues for
     * phase 'interest', `q:any` for 'any') or enqueues it (at the head if `priority`).
     * `sessionId` is recorded on both tickets if they match, so a concurrent cancel can tell
     * which session the visitor ended up in.
     */
    enqueueOrMatch(
      dims: QueueBucket,
      ticket: NewTicket,
      phase: Phase,
      sessionId: string,
      opts: EnqueueOptions = {},
    ): Promise<EnqueueResult> {
      return run(dims, ticket, phase, 'enqueue', sessionId, opts);
    },

    /** Interest fallback: scans `q:any` for a still-waiting ticket, else joins `q:any`. */
    async promoteToAny(
      dims: QueueBucket,
      ticketId: string,
      sessionId: string,
      now: number = Date.now(),
    ): Promise<EnqueueResult> {
      const ticket = await getTicket(dims, ticketId);
      if (ticket === null) return { status: 'not_waiting' };
      return run(dims, ticket, 'any', 'promote', sessionId, { now });
    },

    /**
     * Moves a still-waiting ticket to another bucket (D-052): cancel it in `fromBucket` only if
     * it is still waiting (a concurrent match wins), then enqueue it elsewhere with priority and
     * its original `createdAt`/phase/id. Never loses or duplicates a ticket: either the cancel
     * fails (it was matched) or exactly one waiting copy exists afterwards.
     */
    async hop(
      family: QueueFamily,
      bucketCount: number,
      fromBucket: number,
      ticketId: string,
      sessionId: string,
      now: number = Date.now(),
    ): Promise<HopResult> {
      const from = { ...family, bucket: fromBucket };
      const ticket = await getTicket(from, ticketId);
      if (ticket?.status !== 'waiting') return { status: 'not_waiting' };
      if ((await cancelTicket(from, ticketId)).status !== 'cancelled') {
        return { status: 'not_waiting' };
      }
      const bucket = await chooseBucket(family, bucketCount, ticket.interests, {
        exclude: fromBucket,
      });
      const result = await run({ ...family, bucket }, ticket, ticket.phase, 'enqueue', sessionId, {
        now,
        priority: true,
      });
      return { ...result, bucket };
    },

    /**
     * Deletes stale tickets of one bucket: settled (matched/cancelled) tickets older than
     * `settledAgeMs`, and waiting tickets older than `maxWaitingAgeMs` or owned by a dead
     * gateway node. Queue references to deleted tickets are dropped lazily by later scans.
     * Returns the number of tickets deleted.
     */
    async sweepStale(
      dims: QueueBucket,
      opts: {
        now?: number;
        maxWaitingAgeMs: number;
        settledAgeMs?: number;
        isNodeAlive?: (nodeId: string) => Promise<boolean>;
      },
    ): Promise<number> {
      const now = opts.now ?? Date.now();
      const settledAgeMs = opts.settledAgeMs ?? 120_000;
      const keys = matchmakingKeys(dims);
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

      // Seeks (Part 12) left behind by a crashed node: older than the waiting limit.
      for (const [sessionId, raw] of Object.entries(await redis.hgetall(keys.seeks))) {
        const parsed = seekSchema.safeParse(JSON.parse(raw));
        if (parsed.success && now - parsed.data.createdAt <= opts.maxWaitingAgeMs) continue;
        await redis.multi().hdel(keys.seeks, sessionId).lrem(keys.queueSeek, 0, sessionId).exec();
        dropped += 1;
      }

      return dropped;
    },
  };
}

export type Matchmaker = ReturnType<typeof createMatchmaker>;
