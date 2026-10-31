import { randomInt, randomUUID } from 'node:crypto';

import { type Logger } from '@app/logger';
import { type MatchDimensions, type Matchmaker, type Ticket } from '@app/matchmaking';
import {
  type Redis,
  STATS_MATCHES_TTL_SECONDS,
  statsMatchesKey,
  visitorRoom,
  visitorSocketKey,
} from '@app/redis';
import {
  type ChatMode,
  ErrorCode,
  type QueuePreferences,
  type ServerToClientEvents,
} from '@app/shared';
import { type LeaveReason, type SessionLogJob, sessionLogJobSchema } from '@app/shared/jobs';

import { SocketError } from '../errors.ts';
import { type GatewayServer, type GatewaySocket } from '../types.ts';
import {
  type ActiveParticipant,
  newParticipantId,
  type SessionContext,
  type SessionRef,
  type SessionStore,
} from './store.ts';

/** Leave reasons are never revealed to other participants beyond left/disconnected. */
function publicReason(reason: LeaveReason): 'left' | 'disconnected' {
  return reason === 'DISCONNECT' || reason === 'SERVER_RESTART' || reason === 'RTC_FAILED'
    ? 'disconnected'
    : 'left';
}

/** How long a canceller waits for a just-matched session to be created by the matching node. */
const MATCH_RACE_RETRIES = 20;
const MATCH_RACE_DELAY_MS = 50;

export interface LifecycleDeps {
  io: GatewayServer;
  redis: Redis;
  store: SessionStore;
  matchmaker: Matchmaker;
  nodeId: string;
  interestFallbackMs: number;
  enqueueSessionLog: (job: SessionLogJob) => Promise<void>;
  logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;
  now: () => Date;
}

export interface InSession {
  ref: SessionRef;
  context: SessionContext;
}

export function createLifecycle(deps: LifecycleDeps) {
  const { io, redis, store, matchmaker, nodeId, logger } = deps;
  const clock = () => deps.now().getTime();

  /** Interest-fallback timers of waiting visitors on this node. */
  const promotionTimers = new Map<string, NodeJS.Timeout>();
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

  function clearPromotion(visitorId: string): void {
    const timer = promotionTimers.get(visitorId);
    if (timer !== undefined) clearTimeout(timer);
    promotionTimers.delete(visitorId);
  }

  async function enqueueLog(sessionId: string): Promise<void> {
    try {
      const [meta, context] = await Promise.all([store.meta(sessionId), store.context(sessionId)]);
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
        })),
      });
      await deps.enqueueSessionLog(job);
    } catch (error) {
      // Losing one metadata row is acceptable; failing the user's leave is not.
      logger.error({ err: error, sessionId }, 'failed to enqueue session log');
    }
  }

  /** Creates the session for a fresh match and tells every participant (any node). */
  async function createMatch(input: {
    mode: ChatMode;
    sessionId: string;
    self: { visitorId: string; ticketId: string };
    peer: Ticket;
    commonInterests: string[];
  }): Promise<void> {
    const { mode, sessionId, self, peer, commonInterests } = input;
    const participants: ActiveParticipant[] = [
      { participantId: newParticipantId(), visitorId: self.visitorId },
      { participantId: newParticipantId(), visitorId: peer.visitorId },
    ];
    const now = clock();
    await store.createSession({ sessionId, mode, commonInterests, participants, now });
    await Promise.all([
      store.deleteTicketRef(self.visitorId, self.ticketId),
      store.deleteTicketRef(peer.visitorId, peer.ticketId),
    ]);
    clearPromotion(self.visitorId);
    clearPromotion(peer.visitorId);

    const statsKey = statsMatchesKey(new Date(now));
    await redis.multi().incr(statsKey).expire(statsKey, STATS_MATCHES_TTL_SECONDS).exec();

    // One random initiator (impolite peer, creates the offer) per pair.
    const initiatorIndex = randomInt(0, participants.length);
    participants.forEach((receiver, index) => {
      emitTo(receiver.visitorId, 'match:found', {
        sessionId,
        mode,
        topology: 'mesh',
        maxParticipants: 2,
        selfParticipantId: receiver.participantId,
        peers: participants
          .filter((other) => other !== receiver)
          .map((other) => ({
            participantId: other.participantId,
            initiator: index === initiatorIndex,
            polite: index !== initiatorIndex,
          })),
        commonInterests,
      });
    });
    logger.info({ sessionId, mode, visitors: participants.map((p) => p.visitorId) }, 'matched');
  }

  async function startSearching(socket: GatewaySocket, preferences: QueuePreferences) {
    const { visitorId, pool } = socket.data;
    const dims: MatchDimensions = { pool, mode: preferences.mode, lang: preferences.lang };
    const ticketId = randomUUID();
    const sessionId = randomUUID();
    const now = clock();
    const phase = preferences.interests.length > 0 ? 'interest' : 'any';

    await store.setTicketRef(visitorId, { ...dims, ticketId });
    const result = await matchmaker.enqueueOrMatch(
      dims,
      { ticketId, visitorId, interests: preferences.interests, createdAt: now, nodeId },
      phase,
      sessionId,
      now,
    );

    if (result.status === 'matched') {
      await createMatch({
        mode: dims.mode,
        sessionId,
        self: { visitorId, ticketId },
        peer: result.peer,
        commonInterests: result.commonInterests,
      });
      return;
    }

    socket.data.state = 'waiting';
    emitTo(visitorId, 'queue:waiting', { since: new Date(now).toISOString() });
    if (phase === 'interest') schedulePromotion(socket, dims, ticketId);
  }

  function schedulePromotion(socket: GatewaySocket, dims: MatchDimensions, ticketId: string) {
    const { visitorId } = socket.data;
    clearPromotion(visitorId);
    const timer = setTimeout(() => {
      promotionTimers.delete(visitorId);
      withVisitorLock(visitorId, async () => {
        if (socket.disconnected) return;
        const ref = await store.getTicketRef(visitorId);
        if (ref?.ticketId !== ticketId) return; // matched, cancelled or replaced meanwhile
        const sessionId = randomUUID();
        const result = await matchmaker.promoteToAny(dims, ticketId, sessionId, clock());
        if (result.status === 'matched') {
          await createMatch({
            mode: dims.mode,
            sessionId,
            self: { visitorId, ticketId },
            peer: result.peer,
            commonInterests: result.commonInterests,
          });
        }
      }).catch((error: unknown) => {
        logger.warn({ err: error, visitorId }, 'interest fallback failed');
      });
    }, deps.interestFallbackMs);
    timer.unref();
    promotionTimers.set(visitorId, timer);
  }

  /** Leaves the visitor's current session (atomic, idempotent). Returns false if not in one. */
  async function leaveSession(
    visitorId: string,
    reason: LeaveReason,
    expectedSessionId?: string,
  ): Promise<boolean> {
    const ref = await store.getSessionRef(visitorId);
    if (ref === null) return false;
    if (expectedSessionId !== undefined && ref.sessionId !== expectedSessionId) return false;

    const outcome = await store.leave(ref.sessionId, ref.participantId, reason, clock());
    await store.deleteSessionRef(visitorId, ref.sessionId);
    if (outcome.status !== 'left') return true;

    // Clear the others' refs BEFORE telling them: a client that requeues the instant it sees
    // `peer:left` must already be idle.
    if (outcome.ended) {
      await Promise.all(
        outcome.others.map((other) => store.deleteSessionRef(other.visitorId, ref.sessionId)),
      );
    }
    for (const other of outcome.others) {
      emitTo(other.visitorId, 'peer:left', {
        sessionId: ref.sessionId,
        participantId: ref.participantId,
        reason: publicReason(reason),
        sessionEnded: outcome.ended,
      });
    }
    if (outcome.ended) await enqueueLog(ref.sessionId);
    logger.debug({ sessionId: ref.sessionId, visitorId, reason, ended: outcome.ended }, 'left');
    return true;
  }

  /**
   * A cancel can lose the race against a match made on another node; the matching node is then
   * creating the session right now. Wait for it to appear and leave it.
   */
  async function leaveWhenCreated(visitorId: string, sessionId: string, reason: LeaveReason) {
    for (let attempt = 0; attempt < MATCH_RACE_RETRIES; attempt += 1) {
      const ref = await store.getSessionRef(visitorId);
      if (ref?.sessionId === sessionId) {
        await leaveSession(visitorId, reason, sessionId);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, MATCH_RACE_DELAY_MS));
    }
    logger.warn({ visitorId, sessionId }, 'matched session never appeared; giving up leave');
  }

  /** Cancels the visitor's waiting ticket, if any. Returns false if not waiting. */
  async function cancelSearch(visitorId: string, reasonIfMatched: LeaveReason): Promise<boolean> {
    clearPromotion(visitorId);
    const ref = await store.getTicketRef(visitorId);
    if (ref === null) return false;
    const result = await matchmaker.cancelTicket(ref, ref.ticketId);
    await store.deleteTicketRef(visitorId, ref.ticketId);
    if (result.status === 'matched')
      await leaveWhenCreated(visitorId, result.sessionId, reasonIfMatched);
    return true;
  }

  /** Clears whatever the visitor was doing (queue and/or session). */
  async function abandon(visitorId: string, reason: LeaveReason): Promise<void> {
    await cancelSearch(visitorId, reason);
    await leaveSession(visitorId, reason);
  }

  async function requireSession(visitorId: string, sessionId: string): Promise<SessionRef> {
    const { session } = await store.visitorState(visitorId);
    if (session?.sessionId !== sessionId) {
      throw new SocketError(ErrorCode.NOT_IN_SESSION, 'Not in this session');
    }
    return session;
  }

  return {
    withVisitorLock,

    joinQueue(socket: GatewaySocket, preferences: QueuePreferences): Promise<void> {
      const { visitorId } = socket.data;
      return withVisitorLock(visitorId, async () => {
        const { state } = await store.visitorState(visitorId);
        if (state !== 'idle') {
          throw new SocketError(ErrorCode.INVALID_STATE, `Cannot join the queue while ${state}`);
        }
        socket.data.preferences = preferences;
        await startSearching(socket, preferences);
      });
    },

    leaveQueue(socket: GatewaySocket): Promise<void> {
      const { visitorId } = socket.data;
      return withVisitorLock(visitorId, async () => {
        const { state } = await store.visitorState(visitorId);
        if (state !== 'waiting') {
          throw new SocketError(ErrorCode.INVALID_STATE, `Not waiting (currently ${state})`);
        }
        await cancelSearch(visitorId, 'STOP');
        socket.data.state = 'idle';
      });
    },

    /** `chat:next`: leave the session and rejoin the queue with the same preferences. */
    next(socket: GatewaySocket, sessionId: string): Promise<void> {
      const { visitorId } = socket.data;
      return withVisitorLock(visitorId, async () => {
        await requireSession(visitorId, sessionId);
        const preferences = socket.data.preferences;
        if (preferences === null) {
          throw new SocketError(ErrorCode.INVALID_STATE, 'No queue preferences on this socket');
        }
        await leaveSession(visitorId, 'SKIP', sessionId);
        await startSearching(socket, preferences);
      });
    },

    /** `chat:end`: leave the session and go idle. */
    end(socket: GatewaySocket, sessionId: string): Promise<void> {
      const { visitorId } = socket.data;
      return withVisitorLock(visitorId, async () => {
        await requireSession(visitorId, sessionId);
        await leaveSession(visitorId, 'STOP', sessionId);
        socket.data.state = 'idle';
      });
    },

    /**
     * Membership check for in-session events: the session ref must name `sessionId` and the
     * visitor must still be an active participant of an active session.
     */
    async inSession(socket: GatewaySocket, sessionId: string): Promise<InSession> {
      const ref = await store.getSessionRef(socket.data.visitorId);
      if (ref?.sessionId !== sessionId) {
        throw new SocketError(ErrorCode.NOT_IN_SESSION, 'Not in this session');
      }
      const context = await store.context(sessionId);
      const self = context?.participants.get(ref.participantId);
      if (context?.state !== 'active' || self === undefined || self.leftAt !== undefined) {
        throw new SocketError(ErrorCode.NOT_IN_SESSION, 'Session is over');
      }
      return { ref, context };
    },

    emitTo,

    /**
     * New connection: anything left over from the visitor's previous socket (ticket, session)
     * belongs to a connection that no longer exists — there is no session resume.
     */
    reconcile(socket: GatewaySocket): Promise<void> {
      return withVisitorLock(socket.data.visitorId, () =>
        abandon(socket.data.visitorId, 'DISCONNECT'),
      );
    },

    /** Disconnect clean-up, skipped if a newer socket of the same visitor took over. */
    onDisconnect(socket: GatewaySocket): Promise<void> {
      const { visitorId } = socket.data;
      return withVisitorLock(visitorId, async () => {
        const owner = await redis.get(visitorSocketKey(visitorId));
        if (owner !== null && owner !== socket.id) return;
        await abandon(visitorId, 'DISCONNECT');
      });
    },

    /** Shutdown hook: end every local visitor's queue ticket and session. */
    async endAllLocal(): Promise<void> {
      const sockets = [...io.of('/').sockets.values()];
      await Promise.allSettled(
        sockets.map((socket) =>
          withVisitorLock(socket.data.visitorId, () =>
            abandon(socket.data.visitorId, 'SERVER_RESTART'),
          ),
        ),
      );
      for (const timer of promotionTimers.values()) clearTimeout(timer);
      promotionTimers.clear();
    },
  };
}

export type Lifecycle = ReturnType<typeof createLifecycle>;
