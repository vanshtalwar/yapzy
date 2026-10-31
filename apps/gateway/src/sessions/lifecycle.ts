import { randomInt, randomUUID } from 'node:crypto';

import { type Logger } from '@app/logger';
import { type EnqueueResult, type Matchmaker, type Ticket } from '@app/matchmaking';
import {
  type MatchPool,
  type QueueFamily,
  type Redis,
  STATS_MATCHES_TTL_SECONDS,
  statsMatchesKey,
  visitorRoom,
  visitorSocketKey,
} from '@app/redis';
import {
  ErrorCode,
  type NextReason,
  type PeerRole,
  type QueuePreferences,
  type ServerToClientEvents,
  type SessionResumed,
} from '@app/shared';
import { type LeaveReason, type SessionLogJob, sessionLogJobSchema } from '@app/shared/jobs';

import { SocketError } from '../errors.ts';
import { type GatewayModeration, NO_FRAMES } from '../moderation.ts';
import { type GatewayServer, type GatewaySocket } from '../types.ts';
import {
  type Deadline,
  type LeaveOutcome,
  newParticipantId,
  type ParticipantRecord,
  type ParticipantStatus,
  type SessionContext,
  type SessionRef,
  type SessionStore,
} from './store.ts';

/** Leave reasons are never revealed to other participants beyond left/disconnected. */
function publicReason(reason: LeaveReason): 'left' | 'disconnected' {
  return reason === 'SKIP' || reason === 'STOP' || reason === 'REPORTED' || reason === 'BANNED'
    ? 'left'
    : 'disconnected';
}

/** How long a canceller waits for a just-matched session to be created by the matching node. */
const MATCH_RACE_RETRIES = 20;
const MATCH_RACE_DELAY_MS = 50;
const DEADLINE_BATCH = 100;

export interface LifecycleConfig {
  region: string;
  buckets: number;
  bucketsByQueue: Record<string, number>;
  hopMs: number;
  interestFallbackMs: number;
  reconnectGraceMs: number;
  matchAckTimeoutMs: number;
  earlyFailureWindowMs: number;
  statsShards: number;
}

export interface LifecycleDeps {
  io: GatewayServer;
  redis: Redis;
  store: SessionStore;
  matchmaker: Matchmaker;
  nodeId: string;
  config: LifecycleConfig;
  enqueueSessionLog: (job: SessionLogJob) => Promise<void>;
  /** Trust & safety decisions (Part 8): frame schedules, pools. */
  moderation: GatewayModeration;
  /** Current pool of a connected visitor from the ban cache + trust; 'banned' = HARD ban. */
  resolvePool: (socket: GatewaySocket) => Promise<MatchPool | 'banned'>;
  logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;
  now: () => Date;
}

/** Everything needed to (re)queue a visitor — independent of which node holds their socket. */
export interface Searcher {
  visitorId: string;
  pool: MatchPool;
  preferences: QueuePreferences;
}

export interface InSession {
  ref: SessionRef;
  context: SessionContext;
  self: ParticipantRecord;
}

type MatchedTicket = Pick<Ticket, 'ticketId' | 'visitorId' | 'interests' | 'autoRequeue'>;

export function createLifecycle(deps: LifecycleDeps) {
  const { io, redis, store, matchmaker, nodeId, config, logger } = deps;
  const clock = () => deps.now().getTime();

  /** Waiting-ticket timers (bucket hops + interest fallback) of searches started on this node. */
  const waitTimers = new Map<string, NodeJS.Timeout>();
  /** Serializes lifecycle changes per visitor on this node (events, timers, disconnects). */
  const locks = new Map<string, Promise<unknown>>();

  function emitTo<E extends keyof ServerToClientEvents>(
    visitorId: string,
    event: E,
    ...args: Parameters<ServerToClientEvents[E]>
  ): void {
    io.to(visitorRoom(visitorId)).emit(event, ...args);
  }

  function withVisitorLock<T>(visitorId: string, task: () => Promise<T>): Promise<T> {
    const previous = locks.get(visitorId) ?? Promise.resolve();
    const run = previous.then(task, task);
    const settled = run.catch(() => undefined);
    locks.set(visitorId, settled);
    void settled.then(() => {
      if (locks.get(visitorId) === settled) locks.delete(visitorId);
    });
    return run;
  }

  function bucketCount(family: Pick<QueueFamily, 'mode' | 'lang'>): number {
    return config.bucketsByQueue[`${family.mode}:${family.lang}`] ?? config.buckets;
  }

  function clearWait(visitorId: string): void {
    const timer = waitTimers.get(visitorId);
    if (timer !== undefined) clearTimeout(timer);
    waitTimers.delete(visitorId);
  }

  /**
   * Next wait action: a bucket hop (if > 1 bucket) or the interest fallback, whichever first.
   * Hops are jittered (75–125 %): two lonely tickets that joined together would otherwise hop
   * in lockstep and keep swapping buckets past each other.
   */
  function nextWaitDelay(buckets: number, phase: 'interest' | 'any', waitedMs: number) {
    const hop =
      buckets > 1
        ? Math.round(config.hopMs * (0.75 + Math.random() * 0.5))
        : Number.POSITIVE_INFINITY;
    const promote =
      phase === 'interest'
        ? Math.max(0, config.interestFallbackMs - waitedMs)
        : Number.POSITIVE_INFINITY;
    const delay = Math.min(hop, promote);
    return Number.isFinite(delay) ? delay : null;
  }

  function scheduleWait(visitorId: string, delay: number | null): void {
    clearWait(visitorId);
    if (delay === null) return;
    const timer = setTimeout(() => {
      waitTimers.delete(visitorId);
      withVisitorLock(visitorId, () => waitTick(visitorId)).catch((error: unknown) => {
        logger.warn({ err: error, visitorId }, 'waiting-ticket tick failed');
      });
    }, delay);
    timer.unref();
    waitTimers.set(visitorId, timer);
  }

  async function enqueueLog(sessionId: string): Promise<void> {
    try {
      const [meta, context, frames] = await Promise.all([
        store.meta(sessionId),
        store.context(sessionId),
        store.frameStats(sessionId),
      ]);
      if (meta === null || context === null) return;
      const iso = (ms: number) => new Date(ms).toISOString();
      const job = sessionLogJobSchema.parse({
        sessionId,
        mode: meta.mode,
        topology: 'mesh',
        maxParticipants: meta.maxParticipants,
        commonInterests: meta.commonInterests,
        startedAt: iso(meta.startedAt),
        endedAt: iso(meta.endedAt ?? clock()),
        participants: [...context.participants].map(([participantId, p]) => ({
          participantId,
          visitorId: p.visitorId,
          joinedAt: iso(p.joinedAt),
          leftAt: p.leftAt === undefined ? null : iso(p.leftAt),
          leaveReason: p.leaveReason ?? null,
          ...(p.frameIntervalMs == null
            ? {}
            : {
                frames: {
                  intervalMs: p.frameIntervalMs,
                  maxFrames: p.maxFrames ?? null,
                  received: frames.get(participantId)?.received ?? 0,
                },
              }),
        })),
      });
      await deps.enqueueSessionLog(job);
    } catch (error) {
      // Losing one metadata row is acceptable; failing the user's leave is not.
      logger.error({ err: error, sessionId }, 'failed to enqueue session log');
    }
  }

  function roleFor(initiator: string, receiver: string, other: string): PeerRole {
    // Mesh: the initiator (impolite peer) creates the offer for the pair.
    const receiverStarts = initiator === receiver;
    return { participantId: other, initiator: receiverStarts, polite: !receiverStarts };
  }

  /** Creates the session for a fresh match and tells every participant (any node). */
  async function createMatch(input: {
    family: QueueFamily;
    sessionId: string;
    tickets: [MatchedTicket, MatchedTicket];
    commonInterests: string[];
  }): Promise<void> {
    const { family, sessionId, tickets, commonInterests } = input;
    const participants = await Promise.all(
      tickets.map(async (ticket) => ({
        participantId: newParticipantId(),
        visitorId: ticket.visitorId,
        pool: family.pool,
        interests: ticket.interests,
        autoRequeue: ticket.autoRequeue,
        // Risk-based frame sampling per participant (D-054); never blocks the match.
        frames: await deps.moderation
          .scheduleFor(ticket.visitorId, { mode: family.mode })
          .catch(() => NO_FRAMES),
      })),
    );
    const initiator = participants[randomInt(0, participants.length)]?.participantId ?? '';
    const now = clock();

    await store.createSession({
      sessionId,
      mode: family.mode,
      lang: family.lang,
      commonInterests,
      initiator,
      participants,
      now,
    });
    // Ghost-tab protection (D-047): everyone must `match:ack` in time.
    await Promise.all(
      participants.map(({ participantId }) =>
        store.addDeadline(
          { kind: 'ack', sessionId, participantId },
          now + config.matchAckTimeoutMs,
        ),
      ),
    );
    await Promise.all(tickets.map((t) => store.deleteTicketRef(t.visitorId, t.ticketId)));
    for (const t of tickets) clearWait(t.visitorId);

    const statsKey = statsMatchesKey(new Date(now), randomInt(0, config.statsShards));
    await redis.multi().incr(statsKey).expire(statsKey, STATS_MATCHES_TTL_SECONDS).exec();

    for (const receiver of participants) {
      emitTo(receiver.visitorId, 'match:found', {
        sessionId,
        mode: family.mode,
        topology: 'mesh',
        maxParticipants: 2,
        selfParticipantId: receiver.participantId,
        peers: participants
          .filter((other) => other !== receiver)
          .map((other) => roleFor(initiator, receiver.participantId, other.participantId)),
        moderation: {
          frameIntervalMs: receiver.frames.frameIntervalMs,
          maxFrames: receiver.frames.maxFrames,
        },
        commonInterests,
      });
    }
    logger.info(
      { sessionId, mode: family.mode, visitors: participants.map((p) => p.visitorId) },
      'matched',
    );
  }

  async function handleEnqueue(
    family: QueueFamily,
    sessionId: string,
    self: MatchedTicket,
    result: EnqueueResult,
  ): Promise<boolean> {
    if (result.status !== 'matched') return false;
    await createMatch({
      family,
      sessionId,
      tickets: [self, result.peer],
      commonInterests: result.commonInterests,
    });
    return true;
  }

  async function startSearching(searcher: Searcher, opts: { priority?: boolean } = {}) {
    const { visitorId, pool, preferences } = searcher;
    const family: QueueFamily = {
      region: config.region,
      pool,
      mode: preferences.mode,
      lang: preferences.lang,
    };
    const buckets = bucketCount(family);
    const bucket = await matchmaker.chooseBucket(family, buckets, preferences.interests);
    const ticketId = randomUUID();
    const sessionId = randomUUID();
    const now = clock();
    const phase = preferences.interests.length > 0 ? 'interest' : 'any';
    const self: MatchedTicket = {
      ticketId,
      visitorId,
      interests: preferences.interests,
      autoRequeue: preferences.autoRequeue,
    };

    await store.setTicketRef(visitorId, { ...family, bucket, ticketId });
    const result = await matchmaker.enqueueOrMatch(
      { ...family, bucket },
      { ...self, createdAt: now, nodeId },
      phase,
      sessionId,
      { now, priority: opts.priority ?? false },
    );
    if (await handleEnqueue(family, sessionId, self, result)) return;

    emitTo(visitorId, 'queue:waiting', { since: new Date(now).toISOString() });
    scheduleWait(visitorId, nextWaitDelay(buckets, phase, 0));
  }

  /** Interest fallback and bucket hopping for a still-waiting ticket (D-052). */
  async function waitTick(visitorId: string): Promise<void> {
    const ref = await store.getTicketRef(visitorId);
    if (ref === null) return;
    const ticket = await matchmaker.getTicket(ref, ref.ticketId);
    if (ticket?.status !== 'waiting') return;

    const family: QueueFamily = {
      region: ref.region,
      pool: ref.pool,
      mode: ref.mode,
      lang: ref.lang,
    };
    const buckets = bucketCount(family);
    const now = clock();
    const waited = now - ticket.createdAt;
    const sessionId = randomUUID();
    let phase = ticket.phase;

    if (phase === 'interest' && waited >= config.interestFallbackMs) {
      const result = await matchmaker.promoteToAny(ref, ref.ticketId, sessionId, now);
      if (await handleEnqueue(family, sessionId, ticket, result)) return;
      if (result.status === 'not_waiting') return;
      phase = 'any';
    } else if (buckets > 1) {
      const hop = await matchmaker.hop(family, buckets, ref.bucket, ref.ticketId, sessionId, now);
      if (hop.status === 'not_waiting') return;
      if (await handleEnqueue(family, sessionId, ticket, hop)) return;
      if (!(await store.updateTicketRef(visitorId, { ...ref, bucket: hop.bucket }))) {
        // The visitor left (possibly via another node) while we hopped: undo the new ticket.
        await matchmaker.cancelTicket({ ...family, bucket: hop.bucket }, ref.ticketId);
        return;
      }
    }
    scheduleWait(visitorId, nextWaitDelay(buckets, phase, waited));
  }

  function deadlinesOf(sessionId: string, participantId: string): Deadline[] {
    return [
      { kind: 'ack', sessionId, participantId },
      { kind: 'grace', sessionId, participantId },
    ];
  }

  async function requeueInnocent(
    sessionId: string,
    others: { participantId: string; visitorId: string; priorStatus: ParticipantStatus }[],
  ): Promise<void> {
    const context = await store.context(sessionId);
    if (context === null) return;
    for (const other of others) {
      const record = context.participants.get(other.participantId);
      // Only people who were really there (acked, connected) and asked for it.
      if (other.priorStatus !== 'active' || record?.autoRequeue !== true) continue;
      const { state } = await store.visitorState(other.visitorId);
      if (state !== 'idle') continue;
      await startSearching(
        {
          visitorId: other.visitorId,
          pool: record.pool,
          preferences: {
            mode: context.mode,
            lang: context.lang,
            interests: record.interests,
            autoRequeue: true,
          },
        },
        { priority: true },
      );
      logger.debug({ sessionId, visitorId: other.visitorId }, 'requeued with priority');
    }
  }

  /**
   * Core leave: one atomic script, then clean-up and notifications. On an early failure that
   * wasn't the others' fault (`earlyFailure`), active participants with auto-requeue are
   * requeued at the head of the queue BEFORE they hear `peer:left` (D-048).
   */
  async function leaveParticipant(
    sessionId: string,
    participantId: string,
    visitorId: string,
    reason: LeaveReason,
    opts: { requireStatus?: ParticipantStatus; earlyFailure?: boolean } = {},
  ): Promise<LeaveOutcome> {
    const now = clock();
    const outcome = await store.leave(sessionId, participantId, reason, now, opts.requireStatus);
    if (outcome.status !== 'left') return outcome;

    await store.removeDeadlines(deadlinesOf(sessionId, participantId));
    await store.deleteSessionRef(visitorId, sessionId);

    if (outcome.ended) {
      await store.removeDeadlines(
        outcome.others.flatMap((other) => deadlinesOf(sessionId, other.participantId)),
      );
      await Promise.all(
        outcome.others.map((other) => store.deleteSessionRef(other.visitorId, sessionId)),
      );
      if (opts.earlyFailure === true && now - outcome.startedAt <= config.earlyFailureWindowMs) {
        await requeueInnocent(sessionId, outcome.others);
      }
    }

    for (const other of outcome.others) {
      emitTo(other.visitorId, 'peer:left', {
        sessionId,
        participantId,
        reason: publicReason(reason),
        sessionEnded: outcome.ended,
      });
    }
    if (outcome.ended) await enqueueLog(sessionId);
    logger.debug({ sessionId, visitorId, reason, ended: outcome.ended }, 'left');
    return outcome;
  }

  /** Leaves the visitor's current session. Returns false if not in one. */
  async function leaveSession(
    visitorId: string,
    reason: LeaveReason,
    opts: { expectedSessionId?: string; earlyFailure?: boolean } = {},
  ): Promise<boolean> {
    const ref = await store.getSessionRef(visitorId);
    if (ref === null) return false;
    if (opts.expectedSessionId !== undefined && ref.sessionId !== opts.expectedSessionId) {
      return false;
    }
    const outcome = await leaveParticipant(ref.sessionId, ref.participantId, visitorId, reason, {
      earlyFailure: opts.earlyFailure ?? false,
    });
    // A ref to a session that is gone or that we already left is stale either way.
    if (outcome.status !== 'left') await store.deleteSessionRef(visitorId, ref.sessionId);
    return true;
  }

  /**
   * Signaling connection lost: keep the session (D-046). The participant becomes
   * `reconnecting`; a grace deadline in Redis ends it if they don't resume in time.
   */
  async function markReconnecting(visitorId: string): Promise<void> {
    const ref = await store.getSessionRef(visitorId);
    if (ref === null) return;
    const now = clock();
    const others = await store.disconnect(ref.sessionId, ref.participantId, now);
    if (others === null) return;
    await store.addDeadline(
      { kind: 'grace', sessionId: ref.sessionId, participantId: ref.participantId },
      now + config.reconnectGraceMs,
    );
    for (const other of others) {
      emitTo(other.visitorId, 'peer:reconnecting', {
        sessionId: ref.sessionId,
        participantId: ref.participantId,
      });
    }
  }

  /**
   * Cancels the visitor's waiting ticket. A cancel can lose the race against a match made on
   * another node, which is creating the session right now: wait for it and apply `onMatched`.
   */
  async function cancelSearch(
    visitorId: string,
    onMatched: (sessionId: string) => Promise<void>,
  ): Promise<boolean> {
    clearWait(visitorId);
    const ref = await store.getTicketRef(visitorId);
    if (ref === null) return false;
    const result = await matchmaker.cancelTicket(ref, ref.ticketId);
    await store.deleteTicketRef(visitorId, ref.ticketId);
    if (result.status !== 'matched') return true;

    for (let attempt = 0; attempt < MATCH_RACE_RETRIES; attempt += 1) {
      const session = await store.getSessionRef(visitorId);
      if (session?.sessionId === result.sessionId) {
        await onMatched(result.sessionId);
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, MATCH_RACE_DELAY_MS));
    }
    logger.warn({ visitorId, sessionId: result.sessionId }, 'matched session never appeared');
    return true;
  }

  async function requireSession(visitorId: string, sessionId: string): Promise<SessionRef> {
    const { session } = await store.visitorState(visitorId);
    if (session?.sessionId !== sessionId) {
      throw new SocketError(ErrorCode.NOT_IN_SESSION, 'Not in this session');
    }
    return session;
  }

  function searcherOf(socket: GatewaySocket, preferences: QueuePreferences): Searcher {
    return { visitorId: socket.data.visitorId, pool: socket.data.pool, preferences };
  }

  async function handleDeadline(deadline: Deadline): Promise<void> {
    const context = await store.context(deadline.sessionId);
    const record = context?.participants.get(deadline.participantId);
    if (record === undefined) return;
    await withVisitorLock(record.visitorId, () =>
      leaveParticipant(
        deadline.sessionId,
        deadline.participantId,
        record.visitorId,
        deadline.kind === 'ack' ? 'MATCH_TIMEOUT' : 'DISCONNECT',
        {
          // Someone who acked / resumed since the deadline was set must not be removed.
          requireStatus: deadline.kind === 'ack' ? 'pending' : 'reconnecting',
          earlyFailure: true,
        },
      ),
    );
  }

  /** Cancel a waiting ticket and keep (but mark) any session: used for lost connections. */
  async function suspend(visitorId: string): Promise<void> {
    await cancelSearch(visitorId, () => markReconnecting(visitorId));
    await markReconnecting(visitorId);
  }

  return {
    withVisitorLock,
    emitTo,

    joinQueue(socket: GatewaySocket, preferences: QueuePreferences): Promise<void> {
      const { visitorId } = socket.data;
      return withVisitorLock(visitorId, async () => {
        const { state, session } = await store.visitorState(visitorId);
        if (state === 'in_session' && session !== null) {
          // After a page reload the old session is still `reconnecting`: leave it first.
          const context = await store.context(session.sessionId);
          const self = context?.participants.get(session.participantId);
          if (context?.state === 'active' && self !== undefined && self.status !== 'reconnecting') {
            throw new SocketError(
              ErrorCode.INVALID_STATE,
              'Cannot join the queue while in_session',
            );
          }
          await leaveSession(visitorId, 'DISCONNECT', {
            expectedSessionId: session.sessionId,
            earlyFailure: true,
          });
        } else if (state === 'waiting') {
          throw new SocketError(ErrorCode.INVALID_STATE, 'Cannot join the queue while waiting');
        }
        // Bans and trust can change while connected: re-evaluate the pool on every join.
        const pool = await deps.resolvePool(socket);
        if (pool === 'banned') throw new SocketError(ErrorCode.BANNED, 'Access denied');
        socket.data.pool = pool;
        socket.data.preferences = preferences;
        await startSearching(searcherOf(socket, preferences));
      });
    },

    leaveQueue(socket: GatewaySocket): Promise<void> {
      const { visitorId } = socket.data;
      return withVisitorLock(visitorId, async () => {
        const { state } = await store.visitorState(visitorId);
        if (state !== 'waiting') {
          throw new SocketError(ErrorCode.INVALID_STATE, `Not waiting (currently ${state})`);
        }
        await cancelSearch(visitorId, async (sessionId) => {
          await leaveSession(visitorId, 'STOP', { expectedSessionId: sessionId });
        });
        socket.data.state = 'idle';
      });
    },

    /**
     * `chat:next`: leave the session and rejoin the queue with the same preferences. With
     * `rtc_failed` (video only) the session ends as RTC_FAILED and the others are innocent:
     * requeued with priority if it happened early (D-048). The reporter requeues normally, so
     * claiming a failure never buys a place at the head of the queue.
     */
    next(socket: GatewaySocket, sessionId: string, reason?: NextReason): Promise<void> {
      const { visitorId } = socket.data;
      return withVisitorLock(visitorId, async () => {
        await requireSession(visitorId, sessionId);
        const preferences = socket.data.preferences;
        if (preferences === null) {
          throw new SocketError(ErrorCode.INVALID_STATE, 'No queue preferences on this socket');
        }
        const rtcFailed =
          reason === 'rtc_failed' && (await store.context(sessionId))?.mode === 'video';
        await leaveSession(visitorId, rtcFailed ? 'RTC_FAILED' : 'SKIP', {
          expectedSessionId: sessionId,
          earlyFailure: rtcFailed,
        });
        await startSearching(searcherOf(socket, preferences));
      });
    },

    /** `chat:end`: leave the session and go idle. */
    end(socket: GatewaySocket, sessionId: string): Promise<void> {
      const { visitorId } = socket.data;
      return withVisitorLock(visitorId, async () => {
        await requireSession(visitorId, sessionId);
        await leaveSession(visitorId, 'STOP', { expectedSessionId: sessionId });
        socket.data.state = 'idle';
      });
    },

    /** `match:ack`: the client really is there (D-047). */
    async ack(socket: GatewaySocket, sessionId: string): Promise<void> {
      const ref = await requireSession(socket.data.visitorId, sessionId);
      const result = await store.ack(sessionId, ref.participantId, clock());
      if (result === 'left' || result === 'not_found') {
        throw new SocketError(ErrorCode.NOT_IN_SESSION, 'Session is over');
      }
      await store.removeDeadlines([{ kind: 'ack', sessionId, participantId: ref.participantId }]);
      socket.data.state = 'in_session';
    },

    /** `session:resume` after a reconnect, on any node (D-046). */
    resume(
      socket: GatewaySocket,
      sessionId: string,
      lastMessageId: string | undefined,
    ): Promise<SessionResumed> {
      const { visitorId } = socket.data;
      return withVisitorLock(visitorId, async () => {
        const notResumable = () =>
          new SocketError(ErrorCode.SESSION_NOT_RESUMABLE, 'This session can no longer be resumed');
        const ref = await store.getSessionRef(visitorId);
        if (ref?.sessionId !== sessionId) throw notResumable();
        const resumed = await store.resume(sessionId, ref.participantId, visitorId);
        if (resumed === null) throw notResumable();
        await store.removeDeadlines([
          { kind: 'grace', sessionId, participantId: ref.participantId },
        ]);

        const context = await store.context(sessionId);
        const self = context?.participants.get(ref.participantId);
        if (context === null || self === undefined) throw notResumable();
        socket.data.state = 'in_session';
        socket.data.preferences = {
          mode: context.mode,
          lang: context.lang,
          interests: self.interests,
          autoRequeue: self.autoRequeue,
        };

        const others = [...context.participants].filter(
          ([pid, record]) => pid !== ref.participantId && record.status !== 'left',
        );
        if (resumed.wasReconnecting) {
          for (const [, record] of others) {
            emitTo(record.visitorId, 'peer:resumed', {
              sessionId,
              participantId: ref.participantId,
            });
          }
        }

        // No lastMessageId = "I have none of this session's messages": return everything from
        // the others (≤ 100, the client dedupes by id). A time-based cut-off would lose
        // messages sent between the real drop and the server noticing it (up to the ping
        // timeout).
        const log = await store.readLog(sessionId);
        const missedMessages = log.filter(
          (message) =>
            message.from !== ref.participantId &&
            (lastMessageId === undefined || message.id > lastMessageId), // ulids sort by time
        );
        return {
          selfParticipantId: ref.participantId,
          peers: others.map(([pid]) => roleFor(context.initiator, ref.participantId, pid)),
          missedMessages,
        };
      });
    },

    /**
     * Membership check for in-session events: the session ref must name `sessionId`, the
     * session must be active and the sender must not have left.
     */
    /**
     * `rtc:summary` arrives when a peer connection closes, often after the session ended: it
     * only needs the visitor to have been in this video session, and `peer` to be someone else
     * in it. Ended sessions keep their keys for an hour.
     */
    async checkSummary(socket: GatewaySocket, sessionId: string, peer: string): Promise<void> {
      const context = await store.context(sessionId);
      const self = [...(context?.participants ?? [])].find(
        ([, record]) => record.visitorId === socket.data.visitorId,
      );
      if (context?.mode !== 'video' || self === undefined) {
        throw new SocketError(ErrorCode.NOT_IN_SESSION, 'Not in this session');
      }
      if (peer === self[0] || !context.participants.has(peer)) {
        throw new SocketError(ErrorCode.FORBIDDEN, 'Peer is not in this session');
      }
    },

    /**
     * A report or client NSFW signal in this session: every present participant whose video
     * is sampled less often than the `high` tier is raised to it immediately (D-054).
     */
    async raiseRisk(sessionId: string): Promise<number> {
      const context = await store.context(sessionId);
      if (context?.state !== 'active' || context.mode !== 'video') return 0;
      const high = await deps.moderation.highRisk();
      let raised = 0;
      for (const [participantId, record] of context.participants) {
        if (record.status === 'left') continue;
        const current = record.frameIntervalMs ?? null;
        const sparser =
          current === null ||
          record.maxFrames != null ||
          (high.frameIntervalMs !== null && current > high.frameIntervalMs);
        if (!sparser || !(await store.setSchedule(sessionId, participantId, high))) continue;
        raised += 1;
        emitTo(record.visitorId, 'system:notice', {
          code: 'FRAME_SCHEDULE',
          message: 'Frame sampling changed',
          sessionId,
          moderation: { frameIntervalMs: high.frameIntervalMs, maxFrames: high.maxFrames },
        });
      }
      return raised;
    },

    /**
     * `ban_applied` for a connected visitor. HARD: end the chat, notify, disconnect. SHADOW:
     * end the chat as if the stranger disconnected (the ban stays silent) and move them to the
     * shadow pool; a waiting visitor is re-queued there with the same preferences.
     */
    applyBan(socket: GatewaySocket, banType: 'HARD' | 'SHADOW'): Promise<void> {
      const { visitorId } = socket.data;
      return withVisitorLock(visitorId, async () => {
        const ref = await store.getSessionRef(visitorId);
        if (ref !== null) {
          const outcome = await leaveParticipant(
            ref.sessionId,
            ref.participantId,
            visitorId,
            'BANNED',
          );
          if (banType === 'SHADOW' && outcome.status === 'left') {
            for (const other of outcome.others) {
              emitTo(visitorId, 'peer:left', {
                sessionId: ref.sessionId,
                participantId: other.participantId,
                reason: 'disconnected',
                sessionEnded: outcome.ended,
              });
            }
          }
          if (outcome.status !== 'left') await store.deleteSessionRef(visitorId, ref.sessionId);
        }
        const wasWaiting = await cancelSearch(visitorId, async (sessionId) => {
          await leaveSession(visitorId, 'BANNED', { expectedSessionId: sessionId });
        });
        if (banType === 'HARD') {
          socket.emit('system:notice', { code: 'BANNED', message: 'Access denied' });
          socket.disconnect(true);
          return;
        }
        socket.data.pool = 'shadow';
        const preferences = socket.data.preferences;
        if (wasWaiting && preferences !== null) {
          await startSearching(searcherOf(socket, preferences));
        }
      });
    },

    async inSession(socket: GatewaySocket, sessionId: string): Promise<InSession> {
      const ref = await store.getSessionRef(socket.data.visitorId);
      if (ref?.sessionId !== sessionId) {
        throw new SocketError(ErrorCode.NOT_IN_SESSION, 'Not in this session');
      }
      const context = await store.context(sessionId);
      const self = context?.participants.get(ref.participantId);
      if (context?.state !== 'active' || self === undefined || self.status === 'left') {
        throw new SocketError(ErrorCode.NOT_IN_SESSION, 'Session is over');
      }
      return { ref, context, self };
    },

    /**
     * New connection for this visitor: a previous socket's waiting ticket is dropped (the
     * client requeues), but its session only becomes `reconnecting` — the client can still
     * `session:resume` (D-046).
     */
    reconcile(socket: GatewaySocket): Promise<void> {
      return withVisitorLock(socket.data.visitorId, () => suspend(socket.data.visitorId));
    },

    /** Disconnect: skipped if a newer socket of the same visitor took over. */
    onDisconnect(socket: GatewaySocket): Promise<void> {
      const { visitorId } = socket.data;
      return withVisitorLock(visitorId, async () => {
        const owner = await redis.get(visitorSocketKey(visitorId));
        if (owner !== null && owner !== socket.id) return;
        await suspend(visitorId);
      });
    },

    /** Claims due ack/grace deadlines (exactly once across nodes) and applies them. */
    async processDeadlines(): Promise<number> {
      const due = await store.claimDueDeadlines(clock(), DEADLINE_BATCH);
      await Promise.all(
        due.map((deadline) =>
          handleDeadline(deadline).catch((error: unknown) => {
            logger.warn({ err: error, ...deadline }, 'deadline handling failed');
          }),
        ),
      );
      return due.length;
    },

    /**
     * Shutdown hook (D-046): sessions survive. Local in-session visitors become `reconnecting`
     * (so another node expires them if they never come back); local waiting tickets are
     * cancelled (clients requeue on their new node). Timers stop.
     */
    async prepareShutdown(): Promise<void> {
      const sockets = [...io.of('/').sockets.values()];
      await Promise.allSettled(
        sockets.map((socket) =>
          withVisitorLock(socket.data.visitorId, () => suspend(socket.data.visitorId)),
        ),
      );
      for (const timer of waitTimers.values()) clearTimeout(timer);
      waitTimers.clear();
    },
  };
}

export type Lifecycle = ReturnType<typeof createLifecycle>;
