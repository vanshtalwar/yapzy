import { randomBytes } from 'node:crypto';

import { type Logger } from '@app/logger';
import { type Matchmaker, type Seek, type Ticket } from '@app/matchmaking';
import { type QueueFamily } from '@app/redis';
import {
  ErrorCode,
  MAX_GROUP_PARTICIPANTS,
  type SeekCancelReason,
  type ServerToClientEvents,
} from '@app/shared';

import { SocketError } from '../errors.ts';
import { type GatewayMetrics } from '../metrics.ts';
import { type GatewayModeration, NO_FRAMES } from '../moderation.ts';
import { type SfuOrchestrator } from './sfu.ts';
import {
  newParticipantId,
  type ParticipantRecord,
  type SessionContext,
  type SessionRef,
  type SessionStore,
} from './store.ts';

export interface GroupConfig {
  region: string;
  /** Trust every participant and every joiner needs. */
  minTrust: number;
  seekTimeoutMs: number;
  /** Everyone must answer within this long (ADD_REQUEST_TTL_MS; shorter in tests). */
  addRequestTtlMs: number;
  matchAckTimeoutMs: number;
  bucketCount: (family: Pick<QueueFamily, 'mode' | 'lang'>) => number;
}

/** A ticket that joined a seeking session (from either side's Lua script). */
export type JoiningTicket = Pick<
  Ticket,
  'ticketId' | 'visitorId' | 'interests' | 'autoRequeue' | 'createdAt'
>;

export interface GroupDeps {
  store: SessionStore;
  matchmaker: Matchmaker;
  sfu: SfuOrchestrator;
  moderation: Pick<GatewayModeration, 'trustOf' | 'scheduleFor'>;
  config: GroupConfig;
  emitTo: <E extends keyof ServerToClientEvents>(
    visitorId: string,
    event: E,
    ...args: Parameters<ServerToClientEvents[E]>
  ) => void;
  /** Put a joiner who couldn't be added back at the head of the queue. */
  requeueJoiner: (ticket: JoiningTicket, lang: SessionContext['lang']) => Promise<void>;
  /** The joiner's search on this node (wait timers) is over. */
  clearWait: (visitorId: string) => void;
  /** Group calls are sampled at the `high` tier (Part 8): raise everyone after a join. */
  raiseRisk: (sessionId: string) => Promise<unknown>;
  logger: Pick<Logger, 'debug' | 'info' | 'warn'>;
  metrics: Pick<
    GatewayMetrics,
    'groupAddRequests' | 'groupSeeks' | 'groupTimeToJoin' | 'groupJoins'
  >;
  clock: () => number;
}

const presentOf = (context: SessionContext) =>
  [...context.participants].filter(([, record]) => record.status !== 'left');

const newRoundId = (prefix: string) => `${prefix}${randomBytes(9).toString('base64url')}`;

/**
 * Group calls (Part 12): everyone present agrees to add a random person (`call:requestAdd` →
 * `call:addRequested` → `call:respondAdd`, 15 s); a P2P call first switches to Janus; then the
 * call seeks a joiner among opted-in, eligible visitors (`q:seek` / group tickets, recent
 * pairs avoided with everyone); the joiner is added by Lua (never beyond 4) and gets a token
 * for the room. All rules are enforced here, never by clients.
 */
/** Why `call:requestAdd` can't open a round right now (Lua GROUP_REQUEST). */
const REQUEST_REFUSED = {
  busy: 'Someone is already being added',
  full: 'This call is full',
  not_ready: 'Wait until everyone has joined the call',
  not_active: 'This chat is over',
  not_video: 'Group calls are video calls',
} as const;

export function createGroupCalls(deps: GroupDeps) {
  const { store, matchmaker, sfu, config, logger, metrics, clock } = deps;
  const familyOf = (lang: SessionContext['lang']): QueueFamily => ({
    region: config.region,
    pool: 'normal',
    mode: 'video',
    lang,
  });

  function tell<E extends keyof ServerToClientEvents>(
    context: SessionContext,
    event: E,
    ...args: Parameters<ServerToClientEvents[E]>
  ): void {
    for (const [, record] of presentOf(context)) deps.emitTo(record.visitorId, event, ...args);
  }

  /** Every participant in the normal pool with enough trust (no hint who isn't). */
  async function everyoneEligible(context: SessionContext): Promise<boolean> {
    for (const [, record] of presentOf(context)) {
      if (record.pool !== 'normal') return false;
      if ((await deps.moderation.trustOf(record.visitorId)) < config.minTrust) return false;
    }
    return true;
  }

  /** Ends the running round or seek and tells everyone why (no-op if nothing ran). */
  async function endRound(sessionId: string, reason: SeekCancelReason, seekId = ''): Promise<void> {
    const ended = await store.endGroupRound(sessionId, seekId);
    if (ended === null) return;
    if (ended.seekState === 'seeking' && ended.seekBucket !== null && ended.seekId !== '') {
      const context = await store.context(sessionId);
      if (context !== null) {
        const dims = { ...familyOf(context.lang), bucket: ended.seekBucket };
        const cancelled = await matchmaker.cancelSeek(dims, sessionId, ended.seekId);
        // A joiner being added right now fails its add (seek ended) and is requeued.
        if (cancelled.status === 'filled') await matchmaker.finishSeek(dims, sessionId, ended.seekId);
      }
      await store.removeDeadlines([{ kind: 'seek', sessionId, roundId: ended.seekId }]);
    }
    if (ended.seekState !== '') metrics.groupSeeks.inc({ outcome: reason });
    if (ended.hadRequest) metrics.groupAddRequests.inc({ outcome: reason });
    const context = await store.context(sessionId);
    if (context?.state === 'active') tell(context, 'call:seekCancelled', { sessionId, reason });
    logger.debug({ sessionId, reason }, 'group round ended');
  }

  /** Everyone agreed and the call runs on Janus: look for one more person. */
  async function enqueueSeek(sessionId: string): Promise<void> {
    const context = await store.context(sessionId);
    if (context?.state !== 'active' || context.seek?.state !== 'pending') return;
    if (context.topology !== 'sfu' || context.sfu === null) {
      await endRound(sessionId, 'unavailable');
      return;
    }
    const present = presentOf(context);
    const family = familyOf(context.lang);
    const bucket = await matchmaker.chooseBucket(family, config.bucketCount(family), []);
    const seekId = newRoundId('s');
    const now = clock();
    if (!(await store.beginSeek(sessionId, seekId, bucket, now))) return;
    await store.addDeadline({ kind: 'seek', sessionId, roundId: seekId }, now + config.seekTimeoutMs);
    const result = await matchmaker.seekOrMatch(
      { ...family, bucket },
      { sessionId, seekId, visitorIds: present.map(([, record]) => record.visitorId), createdAt: now },
      { now },
    );
    if (result.status === 'joined') {
      await joinGroup(
        { ...family, bucket },
        result.joiner,
        {
          sessionId,
          seekId,
          visitorIds: present.map(([, record]) => record.visitorId),
          createdAt: now,
          status: 'filled',
          joiner: result.joiner.visitorId,
        },
      );
    }
  }

  /**
   * A group ticket matched a seeking session: add it as a participant (Lua: still seeking,
   * still a free slot), give it a token for the room, and tell everyone. If that fails, the
   * joiner goes back to the head of the queue.
   */
  async function joinGroup(
    dims: QueueFamily & { bucket: number },
    joiner: JoiningTicket,
    seek: Seek,
  ): Promise<void> {
    const { sessionId, seekId } = seek;
    const context = await store.context(sessionId);
    const turnAway = async (why: string) => {
      metrics.groupSeeks.inc({ outcome: 'turned_away' });
      logger.debug({ sessionId, joiner: joiner.visitorId, why }, 'group joiner turned away');
      await matchmaker.finishSeek(dims, sessionId, seekId);
      await deps.requeueJoiner(joiner, dims.lang);
    };
    if (context?.state !== 'active' || context.sfu === null) {
      await turnAway('session over or no room');
      return;
    }
    const room = context.sfu;
    const participantId = newParticipantId();
    const token = sfu.newToken();
    try {
      // Allowed first: a token nobody uses is harmless if the add below fails.
      await sfu.allowToken(room, token);
    } catch (error) {
      logger.warn({ err: error, sessionId }, 'adding a joiner token failed');
      await turnAway('janus');
      // The seek is gone from the queue: end the search now rather than at the timeout.
      await endRound(sessionId, 'unavailable', seekId);
      return;
    }
    const now = clock();
    const frames = await deps.moderation
      .scheduleFor(joiner.visitorId, { mode: 'video', groupCall: true })
      .catch(() => NO_FRAMES);
    const record: ParticipantRecord = {
      visitorId: joiner.visitorId,
      status: 'pending',
      joinedAt: now,
      pool: 'normal',
      interests: joiner.interests,
      autoRequeue: joiner.autoRequeue,
      allowGroup: true,
      frameIntervalMs: frames.frameIntervalMs,
      maxFrames: frames.maxFrames,
      tier: frames.tier,
      sfuToken: token,
    };
    const added = await store.addParticipant(sessionId, participantId, record, seekId, MAX_GROUP_PARTICIPANTS);
    if (added.status !== 'added') {
      await sfu.revokeToken(room, token).catch(() => undefined);
      await turnAway(added.status);
      return;
    }
    await matchmaker.finishSeek(dims, sessionId, seekId);
    await store.removeDeadlines([{ kind: 'seek', sessionId, roundId: seekId }]);
    await store.setSessionRef(joiner.visitorId, { sessionId, participantId } satisfies SessionRef);
    await store.deleteTicketRef(joiner.visitorId, joiner.ticketId);
    deps.clearWait(joiner.visitorId);
    // Ghost-tab protection applies to joiners too (D-047).
    await store.addDeadline({ kind: 'ack', sessionId, participantId }, now + config.matchAckTimeoutMs);

    const join = sfu.joinInfo(room, token, context.topologyEpoch);
    if (join !== null) {
      deps.emitTo(joiner.visitorId, 'match:found', {
        sessionId,
        mode: 'video',
        topology: 'sfu',
        sfu: join,
        maxParticipants: MAX_GROUP_PARTICIPANTS,
        selfParticipantId: participantId,
        // Roles only matter for P2P; everyone reaches the newcomer through Janus.
        peers: added.others.map((other) => ({
          participantId: other.participantId,
          initiator: false,
          polite: true,
        })),
        moderation: { frameIntervalMs: frames.frameIntervalMs, maxFrames: frames.maxFrames },
        commonInterests: [],
      });
    }
    for (const other of added.others) {
      deps.emitTo(other.visitorId, 'participant:joined', { sessionId, participantId });
    }
    const size = added.others.length + 1;
    metrics.groupSeeks.inc({ outcome: 'joined' });
    metrics.groupJoins.inc({ size: String(size) });
    metrics.groupTimeToJoin.observe(Math.max(0, now - added.seekStartedAt) / 1_000);
    await deps.raiseRisk(sessionId).catch(() => undefined);
    logger.info({ sessionId, size }, 'participant joined the group call');
  }

  return {
    joinGroup,

    /** `call:requestAdd`: open a round; everyone present (requester included) is asked. */
    async requestAdd(context: SessionContext, sessionId: string, participantId: string): Promise<void> {
      if (context.mode !== 'video') {
        throw new SocketError(ErrorCode.INVALID_STATE, 'Group calls are video calls');
      }
      if (!sfu.enabled) throw new SocketError(ErrorCode.SERVICE_UNAVAILABLE, 'Group calls are unavailable');
      if (presentOf(context).length >= MAX_GROUP_PARTICIPANTS) {
        throw new SocketError(ErrorCode.INVALID_STATE, 'This call is full');
      }
      if (!(await everyoneEligible(context))) {
        metrics.groupAddRequests.inc({ outcome: 'not_eligible' });
        throw new SocketError(ErrorCode.FORBIDDEN, 'Adding people isn’t available in this chat');
      }
      const now = clock();
      const request = {
        requestId: newRoundId('r'),
        by: participantId,
        accepted: [participantId],
        expiresAt: now + config.addRequestTtlMs,
      };
      const result = await store.requestAdd(sessionId, participantId, request, MAX_GROUP_PARTICIPANTS);
      if (result !== 'ok') throw new SocketError(ErrorCode.INVALID_STATE, REQUEST_REFUSED[result]);
      await store.addDeadline({ kind: 'consent', sessionId, roundId: request.requestId }, request.expiresAt);
      metrics.groupAddRequests.inc({ outcome: 'requested' });
      tell(context, 'call:addRequested', {
        sessionId,
        requestId: request.requestId,
        by: participantId,
        expiresAt: new Date(request.expiresAt).toISOString(),
      });
    },

    /**
     * `call:respondAdd`: a decline ends the round for everyone; the last accept starts the
     * search — on a P2P call, the switch to Janus comes first (hidden behind the search wait).
     */
    async respondAdd(
      sessionId: string,
      participantId: string,
      requestId: string,
      accept: boolean,
    ): Promise<void> {
      const result = await store.respondAdd(
        sessionId,
        participantId,
        requestId,
        accept,
        MAX_GROUP_PARTICIPANTS,
      );
      if (result === 'stale') throw new SocketError(ErrorCode.INVALID_STATE, 'No such request');
      if (result === 'pending') return;
      await store.removeDeadlines([{ kind: 'consent', sessionId, roundId: requestId }]);
      const context = await store.context(sessionId);
      if (context === null) return;
      if (result === 'declined') {
        metrics.groupAddRequests.inc({ outcome: 'declined' });
        tell(context, 'call:seekCancelled', { sessionId, reason: 'declined' });
        return;
      }
      metrics.groupAddRequests.inc({ outcome: 'accepted' });
      tell(context, 'call:seeking', {
        sessionId,
        until: new Date(clock() + config.seekTimeoutMs).toISOString(),
      });
      if (context.topology === 'sfu') {
        await enqueueSeek(sessionId);
        return;
      }
      const outcome = await sfu.upgrade(sessionId);
      if (outcome === 'started' || outcome === 'upgrading') return; // continues in upgradeSettled
      if (outcome === 'already') await enqueueSeek(sessionId);
      else await endRound(sessionId, 'unavailable');
    },

    /** The switch to Janus for a pending seek finished — or was rolled back. */
    async upgradeSettled(sessionId: string, upgraded: boolean): Promise<void> {
      const context = await store.context(sessionId);
      if (context?.seek?.state !== 'pending') return;
      if (upgraded) await enqueueSeek(sessionId);
      else await endRound(sessionId, 'unavailable');
    },

    async consentExpired(sessionId: string, requestId: string): Promise<void> {
      if (!(await store.expireAdd(sessionId, requestId))) return;
      metrics.groupAddRequests.inc({ outcome: 'expired' });
      const context = await store.context(sessionId);
      if (context?.state === 'active') tell(context, 'call:seekCancelled', { sessionId, reason: 'expired' });
    },

    /** Nobody joined in time; a seek that was just filled is left alone (the add decides). */
    async seekExpired(sessionId: string, seekId: string): Promise<void> {
      const context = await store.context(sessionId);
      if (context?.seek?.seekId !== seekId || context.seek.bucket === null) return;
      const dims = { ...familyOf(context.lang), bucket: context.seek.bucket };
      const seek = await matchmaker.getSeek(dims, sessionId);
      if (seek?.seekId === seekId && seek.status === 'filled') return;
      await endRound(sessionId, 'timeout', seekId);
    },

    /** Someone left: a running round or seek ends (a new person needs a fresh round). */
    async afterLeave(sessionId: string): Promise<void> {
      await endRound(sessionId, 'left');
    },
  };
}

export type GroupCalls = ReturnType<typeof createGroupCalls>;
