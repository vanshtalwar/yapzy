import { randomBytes } from 'node:crypto';

import { type FrameSchedule, RISK_TIERS } from '@app/moderation';
import {
  deadlineShardOf,
  type FrameStats,
  frameStatsSchema,
  type MatchPool,
  type Redis,
  sessionDeadlinesKey,
  sessionKeys,
  visitorSessionKey,
  visitorTicketKey,
} from '@app/redis';
import {
  type ChatMessageOut,
  chatMessageOutSchema,
  type ChatMode,
  chatModeSchema,
  langSchema,
  participantIdSchema,
  type SupportedLang,
  TOPOLOGIES,
  type Topology,
  type VisitorState,
} from '@app/shared';
import { LEAVE_REASONS, type LeaveReason } from '@app/shared/jobs';
import { type Result } from 'ioredis';
import { z } from 'zod';

declare module 'ioredis' {
  interface RedisCommander<Context> {
    gwSessionSchedule(
      participants: string,
      participantId: string,
      frameIntervalMs: string,
      maxFrames: string,
      tier: string,
    ): Result<unknown, Context>;
    gwSessionLeave(
      meta: string,
      participants: string,
      log: string,
      frames: string,
      participantId: string,
      reason: string,
      nowMs: number,
      ttlSeconds: number,
      requireStatus: string,
    ): Result<unknown, Context>;
    gwSessionAck(
      meta: string,
      participants: string,
      participantId: string,
      nowMs: number,
    ): Result<unknown, Context>;
    gwSessionDisconnect(
      meta: string,
      participants: string,
      participantId: string,
      nowMs: number,
    ): Result<unknown, Context>;
    gwSessionResume(
      meta: string,
      participants: string,
      participantId: string,
      visitorId: string,
    ): Result<unknown, Context>;
    gwSfuBegin(meta: string, nowMs: number): Result<unknown, Context>;
    gwSfuAssign(
      meta: string,
      participants: string,
      epoch: number,
      nodeId: string,
      roomId: number,
      ...tokens: string[]
    ): Result<unknown, Context>;
    gwSfuReady(
      meta: string,
      participants: string,
      participantId: string,
      epoch: number,
    ): Result<unknown, Context>;
    gwSfuRollback(meta: string, epoch: number): Result<unknown, Context>;
    gwSfuMove(meta: string, nodeId: string, roomId: number): Result<unknown, Context>;
    gwDelIfField(key: string, field: string, value: string): Result<unknown, Context>;
    gwSetIfField(
      key: string,
      field: string,
      expected: string,
      value: string,
      ttlSeconds: number,
    ): Result<unknown, Context>;
  }
}

/** Session keys stay this long after the session ends (reports can still reference it). */
export const ENDED_SESSION_TTL_SECONDS = 60 * 60;
/** Safety TTL on live session keys and visitor refs (a crashed node can't leak them forever). */
const LIVE_TTL_SECONDS = 24 * 60 * 60;

// --- Lua -----------------------------------------------------------------------------------
// Participant records are JSON: { visitorId, status, joinedAt, ackedAt?, disconnectedAt?,
// leftAt?, leaveReason?, pool, interests, autoRequeue }. status: pending → active →
// (reconnecting ↔ active) → left. "Present" = any status except left.

/**
 * KEYS: meta, participants, log, frames   ARGV: participantId, reason, nowMs, ttlSeconds, requireStatus
 * Marks the participant left (idempotent). With `requireStatus`, only if the participant is
 * still in that status (deadline handlers must not remove someone who acked/resumed since).
 * If fewer than 2 participants remain present, the session ends: the rest are marked left (no
 * reason), state=ended, all keys get the TTL. Exactly one caller ever observes ended=1.
 * Returns {'not_found'} | {'not_participant'} | {'already_left'} | {'skipped'} |
 *   {'left', ended, startedAt, pid, visitorId, priorStatus, ...} (others present before)
 */
const SESSION_LEAVE = `
local state = redis.call('HGET', KEYS[1], 'state')
if not state then return {'not_found'} end
local raw = redis.call('HGET', KEYS[2], ARGV[1])
if not raw then return {'not_participant'} end
local now = tonumber(ARGV[3])
local me = cjson.decode(raw)
if me.status == 'left' then return {'already_left'} end
if ARGV[5] ~= '' and me.status ~= ARGV[5] then return {'skipped'} end
me.status = 'left'
me.leftAt = now
me.leaveReason = ARGV[2]
redis.call('HSET', KEYS[2], ARGV[1], cjson.encode(me))

local others = {}
local records = {}
local flat = redis.call('HGETALL', KEYS[2])
for i = 1, #flat, 2 do
  local p = cjson.decode(flat[i + 1])
  if p.status ~= 'left' then
    others[#others + 1] = flat[i]
    others[#others + 1] = p.visitorId
    others[#others + 1] = p.status
    records[flat[i]] = p
  end
end

local ended = 0
if #others / 3 < 2 and state ~= 'ended' then
  for pid, p in pairs(records) do
    p.status = 'left'
    p.leftAt = now
    redis.call('HSET', KEYS[2], pid, cjson.encode(p))
  end
  redis.call('HSET', KEYS[1], 'state', 'ended', 'endedAt', now)
  for i = 1, 4 do redis.call('EXPIRE', KEYS[i], tonumber(ARGV[4])) end
  ended = 1
end

local result = {'left', ended, redis.call('HGET', KEYS[1], 'startedAt') or '0'}
for _, value in ipairs(others) do result[#result + 1] = value end
return result
`;

/**
 * KEYS: participants   ARGV: participantId, frameIntervalMs ('' = none), maxFrames ('' = none),
 * tier. Sets the participant's frame schedule unless they left. Returns 1 if updated.
 */
const SESSION_SCHEDULE = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return 0 end
local p = cjson.decode(raw)
if p.status == 'left' then return 0 end
p.frameIntervalMs = ARGV[2] ~= '' and tonumber(ARGV[2]) or cjson.null
p.maxFrames = ARGV[3] ~= '' and tonumber(ARGV[3]) or cjson.null
p.tier = ARGV[4]
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(p))
return 1
`;

/** KEYS: meta, participants   ARGV: participantId, nowMs → 'acked'|'already'|'left'|'not_found' */
const SESSION_ACK = `
if redis.call('HGET', KEYS[1], 'state') ~= 'active' then return 'not_found' end
local raw = redis.call('HGET', KEYS[2], ARGV[1])
if not raw then return 'not_found' end
local p = cjson.decode(raw)
if p.status == 'left' then return 'left' end
if p.ackedAt then return 'already' end
p.ackedAt = tonumber(ARGV[2])
if p.status == 'pending' then p.status = 'active' end
redis.call('HSET', KEYS[2], ARGV[1], cjson.encode(p))
return 'acked'
`;

/**
 * KEYS: meta, participants   ARGV: participantId, nowMs
 * pending|active → reconnecting. Returns {'reconnecting', pid, visitorId, ...} (others present)
 * or {'noop'}.
 */
const SESSION_DISCONNECT = `
if redis.call('HGET', KEYS[1], 'state') ~= 'active' then return {'noop'} end
local raw = redis.call('HGET', KEYS[2], ARGV[1])
if not raw then return {'noop'} end
local me = cjson.decode(raw)
if me.status ~= 'pending' and me.status ~= 'active' then return {'noop'} end
me.status = 'reconnecting'
me.disconnectedAt = tonumber(ARGV[2])
redis.call('HSET', KEYS[2], ARGV[1], cjson.encode(me))
local result = {'reconnecting'}
local flat = redis.call('HGETALL', KEYS[2])
for i = 1, #flat, 2 do
  local p = cjson.decode(flat[i + 1])
  if flat[i] ~= ARGV[1] and p.status ~= 'left' then
    result[#result + 1] = flat[i]
    result[#result + 1] = p.visitorId
  end
end
return result
`;

/**
 * KEYS: meta, participants   ARGV: participantId, visitorId
 * reconnecting (or still pending/active if the disconnect wasn't processed yet) → active, or
 * pending if the match was never acked. Returns {'resumed', wasReconnecting, disconnectedAt}
 * or {'not_resumable'}.
 */
const SESSION_RESUME = `
if redis.call('HGET', KEYS[1], 'state') ~= 'active' then return {'not_resumable'} end
local raw = redis.call('HGET', KEYS[2], ARGV[1])
if not raw then return {'not_resumable'} end
local me = cjson.decode(raw)
if me.visitorId ~= ARGV[2] or me.status == 'left' then return {'not_resumable'} end
local was = 0
if me.status == 'reconnecting' then was = 1 end
local disconnectedAt = me.disconnectedAt or 0
if me.ackedAt then me.status = 'active' else me.status = 'pending' end
me.disconnectedAt = nil
redis.call('HSET', KEYS[2], ARGV[1], cjson.encode(me))
return {'resumed', was, disconnectedAt}
`;

// --- Topology (Part 11): mesh → sfu upgrades, failover moves --------------------------------
// meta: topology mesh|sfu, topologyEpoch (+1 per change), topologyState stable|upgrading,
// sfuNodeId/sfuRoomId (current room), upgradeStartedAt. Participant records: sfuToken (their
// token in the room's allowed list), sfuReadyEpoch (confirmed `call:topologyReady`).

/**
 * KEYS: meta   ARGV: nowMs
 * Starts a mesh → sfu upgrade: one at a time, video only, never twice.
 * Returns {'started', epoch} | {'not_active'} | {'not_video'} | {'already'} | {'upgrading'}
 */
const SFU_BEGIN = `
local m = redis.call('HMGET', KEYS[1], 'state', 'mode', 'topology', 'topologyState', 'topologyEpoch')
if m[1] ~= 'active' then return {'not_active'} end
if m[2] ~= 'video' then return {'not_video'} end
if m[3] == 'sfu' then return {'already'} end
if m[4] == 'upgrading' then return {'upgrading'} end
local epoch = tonumber(m[5] or '0') + 1
redis.call('HSET', KEYS[1], 'topologyState', 'upgrading', 'topologyEpoch', epoch,
  'upgradeStartedAt', ARGV[1])
return {'started', epoch}
`;

/**
 * KEYS: meta, participants   ARGV: epoch, nodeId, roomId, (participantId, token)...
 * Records the room of `epoch` and each present participant's token, if `epoch` is still the
 * current one. Returns 'ok' | 'stale'.
 */
const SFU_ASSIGN = `
local m = redis.call('HMGET', KEYS[1], 'state', 'topologyEpoch')
if m[1] ~= 'active' or tonumber(m[2] or '0') ~= tonumber(ARGV[1]) then return 'stale' end
redis.call('HSET', KEYS[1], 'sfuNodeId', ARGV[2], 'sfuRoomId', ARGV[3])
for i = 4, #ARGV, 2 do
  local raw = redis.call('HGET', KEYS[2], ARGV[i])
  if raw then
    local p = cjson.decode(raw)
    if p.status ~= 'left' then
      p.sfuToken = ARGV[i + 1]
      p.sfuReadyEpoch = nil
      redis.call('HSET', KEYS[2], ARGV[i], cjson.encode(p))
    end
  end
end
return 'ok'
`;

/**
 * KEYS: meta, participants   ARGV: participantId, epoch
 * The participant receives everyone through the topology of `epoch`. When every present
 * participant has confirmed, an upgrade completes (topology=sfu, stable).
 * Returns {'pending'} | {'complete', upgraded (1 = was an upgrade), upgradeStartedAt} |
 *   {'stale'} | {'not_active'}
 */
const SFU_READY = `
local m = redis.call('HMGET', KEYS[1], 'state', 'topologyEpoch', 'topologyState', 'upgradeStartedAt')
if m[1] ~= 'active' then return {'not_active'} end
local epoch = tonumber(ARGV[2])
if tonumber(m[2] or '0') ~= epoch then return {'stale'} end
local raw = redis.call('HGET', KEYS[2], ARGV[1])
if not raw then return {'stale'} end
local me = cjson.decode(raw)
if me.status == 'left' then return {'stale'} end
me.sfuReadyEpoch = epoch
redis.call('HSET', KEYS[2], ARGV[1], cjson.encode(me))
local flat = redis.call('HGETALL', KEYS[2])
for i = 1, #flat, 2 do
  local p = cjson.decode(flat[i + 1])
  if p.status ~= 'left' and p.sfuReadyEpoch ~= epoch then return {'pending'} end
end
if m[3] == 'upgrading' then
  redis.call('HSET', KEYS[1], 'topology', 'sfu', 'topologyState', 'stable')
  return {'complete', 1, m[4] or '0'}
end
return {'complete', 0, '0'}
`;

/**
 * KEYS: meta   ARGV: epoch
 * Rolls back a still-pending upgrade of `epoch` (the P2P call never stopped). Returns
 * {'rolled_back', nodeId, roomId} (empty strings if no room was recorded yet) | {'stale'}
 */
const SFU_ROLLBACK = `
local m = redis.call('HMGET', KEYS[1], 'topologyEpoch', 'topologyState', 'sfuNodeId', 'sfuRoomId')
if tonumber(m[1] or '0') ~= tonumber(ARGV[1]) or m[2] ~= 'upgrading' then return {'stale'} end
redis.call('HSET', KEYS[1], 'topologyState', 'stable')
redis.call('HDEL', KEYS[1], 'sfuNodeId', 'sfuRoomId', 'upgradeStartedAt')
return {'rolled_back', m[3] or '', m[4] or ''}
`;

/**
 * KEYS: meta   ARGV: nodeId, roomId
 * Failover: an SFU call whose room is (still) `nodeId`/`roomId` gets a new epoch for its new
 * room. Returns {'moving', epoch} | {'stale'}
 */
const SFU_MOVE = `
local m = redis.call('HMGET', KEYS[1], 'state', 'topology', 'sfuNodeId', 'sfuRoomId', 'topologyEpoch')
if m[1] ~= 'active' or m[2] ~= 'sfu' or m[3] ~= ARGV[1] or m[4] ~= ARGV[2] then
  return {'stale'}
end
local epoch = tonumber(m[5] or '0') + 1
redis.call('HSET', KEYS[1], 'topologyEpoch', epoch)
return {'moving', epoch}
`;

/** KEYS: key   ARGV: field, value — deletes a JSON ref only if ref[field] == value. */
const DEL_IF_FIELD = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, ref = pcall(cjson.decode, raw)
if ok and ref[ARGV[1]] == ARGV[2] then return redis.call('DEL', KEYS[1]) end
return 0
`;

/** KEYS: key   ARGV: field, expected, newJson, ttlSeconds — replaces the ref only if it matches. */
const SET_IF_FIELD = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, ref = pcall(cjson.decode, raw)
if ok and ref[ARGV[1]] == ARGV[2] then
  redis.call('SET', KEYS[1], ARGV[3], 'EX', tonumber(ARGV[4]))
  return 1
end
return 0
`;

// --- Schemas -------------------------------------------------------------------------------

/** cjson writes an empty Lua table as `{}`; records re-encoded by a script may carry that. */
const stringList = z.preprocess(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
      ? []
      : value,
  z.array(z.string()),
);

/** `visitor:<id>:ticket` — where the visitor's waiting ticket lives. */
export const ticketRefSchema = z.object({
  region: z.string().min(1),
  pool: z.enum(['normal', 'shadow']),
  mode: chatModeSchema,
  lang: langSchema,
  bucket: z.number().int().min(0),
  ticketId: z.uuid(),
});
export type TicketRef = z.output<typeof ticketRefSchema>;

/** `visitor:<id>:session` — the visitor's current session and their participant id in it. */
export const sessionRefSchema = z.object({
  sessionId: z.uuid(),
  participantId: participantIdSchema,
});
export type SessionRef = z.output<typeof sessionRefSchema>;

export const PARTICIPANT_STATUSES = ['pending', 'active', 'reconnecting', 'left'] as const;
export type ParticipantStatus = (typeof PARTICIPANT_STATUSES)[number];

const participantRecordSchema = z.object({
  visitorId: z.string().min(1),
  status: z.enum(PARTICIPANT_STATUSES),
  joinedAt: z.number(),
  ackedAt: z.number().optional(),
  disconnectedAt: z.number().optional(),
  leftAt: z.number().optional(),
  leaveReason: z.enum(LEAVE_REASONS).optional(),
  pool: z.enum(['normal', 'shadow']),
  interests: stringList,
  autoRequeue: z.boolean(),
  // Moderation frame sampling (D-054); read by the API's frame upload endpoint.
  frameIntervalMs: z.number().int().positive().nullable().optional(),
  maxFrames: z.number().int().positive().nullable().optional(),
  tier: z.enum(RISK_TIERS).optional(),
  // Janus (Part 11): this participant's token in the room's allowed list, and the topology
  // epoch they confirmed with `call:topologyReady`.
  sfuToken: z.string().optional(),
  sfuReadyEpoch: z.number().int().optional(),
});
export type ParticipantRecord = z.output<typeof participantRecordSchema>;

export interface NewParticipant {
  participantId: string;
  visitorId: string;
  pool: MatchPool;
  interests: string[];
  autoRequeue: boolean;
  frames: FrameSchedule;
  /** Token in the room's allowed list when the session starts on Janus. */
  sfuToken?: string;
}

export interface PresentParticipant {
  participantId: string;
  visitorId: string;
}

export type LeaveOutcome =
  | { status: 'not_found' | 'not_participant' | 'already_left' | 'skipped' }
  | {
      status: 'left';
      ended: boolean;
      startedAt: number;
      others: (PresentParticipant & { priorStatus: ParticipantStatus })[];
    };

export type TopologyState = 'stable' | 'upgrading';

/** The call's current Janus room (absent while the call is P2P only). */
export interface SfuPlacement {
  nodeId: string;
  roomId: number;
}

export interface SessionContext {
  state: 'active' | 'ended';
  mode: ChatMode;
  lang: SupportedLang;
  startedAt: number;
  initiator: string;
  participants: Map<string, ParticipantRecord>;
  topology: Topology;
  topologyEpoch: number;
  topologyState: TopologyState;
  sfu: SfuPlacement | null;
}

export interface SessionMeta {
  mode: ChatMode;
  /** Where the call ended up (a call that switched to Janus is logged as sfu). */
  topology: Topology;
  startedAt: number;
  endedAt: number | null;
  maxParticipants: number;
  commonInterests: string[];
}

/** Per-participant deadlines: match ack (D-047) and reconnect grace (D-046). */
export interface ParticipantDeadline {
  kind: 'ack' | 'grace';
  sessionId: string;
  participantId: string;
}

/** A mesh → SFU upgrade must be confirmed by everyone before this (Part 11). */
export interface UpgradeDeadline {
  kind: 'upgrade';
  sessionId: string;
  epoch: number;
}

export type Deadline = ParticipantDeadline | UpgradeDeadline;
export type DeadlineKind = Deadline['kind'];

/** Random, unguessable per-session id shown to other participants instead of visitor ids. */
export function newParticipantId(): string {
  return `p${randomBytes(9).toString('base64url')}`;
}

const leaveResultSchema = z.union([
  z.tuple([z.enum(['not_found', 'not_participant', 'already_left', 'skipped'])]),
  z.tuple([z.literal('left'), z.union([z.literal(0), z.literal(1)]), z.string()]).rest(z.string()),
]);
const presentListSchema = z.tuple([z.string()]).rest(z.string());
const resumeResultSchema = z.union([
  z.tuple([z.literal('not_resumable')]),
  z.tuple([z.literal('resumed'), z.union([z.literal(0), z.literal(1)]), z.number()]),
]);
const deadlineMemberSchema = z
  .string()
  .transform((member) => member.split('|'))
  .pipe(
    z.union([
      z.tuple([z.enum(['ack', 'grace']), z.uuid(), participantIdSchema]),
      z.tuple([z.literal('upgrade'), z.uuid(), z.string().regex(/^\d{1,9}$/)]),
    ]),
  );
const okListSchema = z.tuple([z.string()]).rest(z.union([z.string(), z.number()]));

export function createSessionStore(redis: Redis, options: { deadlineShards: number }) {
  redis.defineCommand('gwSessionLeave', { numberOfKeys: 4, lua: SESSION_LEAVE });
  redis.defineCommand('gwSessionSchedule', { numberOfKeys: 1, lua: SESSION_SCHEDULE });
  redis.defineCommand('gwSessionAck', { numberOfKeys: 2, lua: SESSION_ACK });
  redis.defineCommand('gwSessionDisconnect', { numberOfKeys: 2, lua: SESSION_DISCONNECT });
  redis.defineCommand('gwSessionResume', { numberOfKeys: 2, lua: SESSION_RESUME });
  redis.defineCommand('gwSfuBegin', { numberOfKeys: 1, lua: SFU_BEGIN });
  redis.defineCommand('gwSfuAssign', { numberOfKeys: 2, lua: SFU_ASSIGN });
  redis.defineCommand('gwSfuReady', { numberOfKeys: 2, lua: SFU_READY });
  redis.defineCommand('gwSfuRollback', { numberOfKeys: 1, lua: SFU_ROLLBACK });
  redis.defineCommand('gwSfuMove', { numberOfKeys: 1, lua: SFU_MOVE });
  redis.defineCommand('gwDelIfField', { numberOfKeys: 1, lua: DEL_IF_FIELD });
  redis.defineCommand('gwSetIfField', { numberOfKeys: 1, lua: SET_IF_FIELD });

  const deadlineKeyOf = (sessionId: string) =>
    sessionDeadlinesKey(deadlineShardOf(sessionId, options.deadlineShards));
  const memberOf = (d: Deadline) =>
    `${d.kind}|${d.sessionId}|${d.kind === 'upgrade' ? String(d.epoch) : d.participantId}`;

  async function getRef<T>(key: string, schema: z.ZodType<T>): Promise<T | null> {
    const raw = await redis.get(key);
    if (raw === null) return null;
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null; // corrupt ref = no ref
  }

  function pairs(flat: string[], size: number): string[][] {
    const out: string[][] = [];
    for (let i = 0; i + size - 1 < flat.length; i += size) out.push(flat.slice(i, i + size));
    return out;
  }

  return {
    /**
     * Authoritative visitor state, derived from Redis (D-038): a session ref wins over a ticket
     * ref, so a visitor matched by another node is "in_session" everywhere immediately.
     */
    async visitorState(visitorId: string): Promise<{
      state: VisitorState;
      session: SessionRef | null;
      ticket: TicketRef | null;
    }> {
      const [session, ticket] = await Promise.all([
        getRef(visitorSessionKey(visitorId), sessionRefSchema),
        getRef(visitorTicketKey(visitorId), ticketRefSchema),
      ]);
      const state = session !== null ? 'in_session' : ticket !== null ? 'waiting' : 'idle';
      return { state, session, ticket };
    },

    getSessionRef: (visitorId: string) => getRef(visitorSessionKey(visitorId), sessionRefSchema),
    getTicketRef: (visitorId: string) => getRef(visitorTicketKey(visitorId), ticketRefSchema),

    async setTicketRef(visitorId: string, ref: TicketRef): Promise<void> {
      await redis.set(visitorTicketKey(visitorId), JSON.stringify(ref), 'EX', LIVE_TTL_SECONDS);
    },

    /** Moves the ref to a new bucket only if it still names `ticketId` (visitor didn't leave). */
    async updateTicketRef(visitorId: string, ref: TicketRef): Promise<boolean> {
      const updated = await redis.gwSetIfField(
        visitorTicketKey(visitorId),
        'ticketId',
        ref.ticketId,
        JSON.stringify(ref),
        LIVE_TTL_SECONDS,
      );
      return updated === 1;
    },

    async deleteTicketRef(visitorId: string, ticketId: string): Promise<void> {
      await redis.gwDelIfField(visitorTicketKey(visitorId), 'ticketId', ticketId);
    },

    async deleteSessionRef(visitorId: string, sessionId: string): Promise<void> {
      await redis.gwDelIfField(visitorSessionKey(visitorId), 'sessionId', sessionId);
    },

    /** Session keys first, then refs: anyone who sees a ref also finds the session. */
    async createSession(input: {
      sessionId: string;
      mode: ChatMode;
      lang: SupportedLang;
      commonInterests: string[];
      initiator: string;
      participants: NewParticipant[];
      now: number;
      /** Set when the call starts on Janus (epoch 1); P2P otherwise. */
      sfu?: SfuPlacement;
    }): Promise<void> {
      const keys = sessionKeys(input.sessionId);
      const multi = redis.multi().hset(keys.meta, {
        mode: input.mode,
        lang: input.lang,
        topology: input.sfu === undefined ? 'mesh' : 'sfu',
        topologyEpoch: input.sfu === undefined ? '0' : '1',
        topologyState: 'stable',
        ...(input.sfu === undefined
          ? {}
          : { sfuNodeId: input.sfu.nodeId, sfuRoomId: String(input.sfu.roomId) }),
        maxParticipants: '2',
        startedAt: String(input.now),
        commonInterests: JSON.stringify(input.commonInterests),
        initiator: input.initiator,
        state: 'active',
      });
      for (const p of input.participants) {
        const record: ParticipantRecord = {
          visitorId: p.visitorId,
          status: 'pending',
          joinedAt: input.now,
          pool: p.pool,
          interests: p.interests,
          autoRequeue: p.autoRequeue,
          frameIntervalMs: p.frames.frameIntervalMs,
          maxFrames: p.frames.maxFrames,
          tier: p.frames.tier,
          ...(p.sfuToken === undefined ? {} : { sfuToken: p.sfuToken }),
        };
        multi.hset(keys.participants, p.participantId, JSON.stringify(record));
      }
      multi.expire(keys.meta, LIVE_TTL_SECONDS).expire(keys.participants, LIVE_TTL_SECONDS);
      await multi.exec();

      await Promise.all(
        input.participants.map(({ participantId, visitorId }) =>
          redis.set(
            visitorSessionKey(visitorId),
            JSON.stringify({ sessionId: input.sessionId, participantId } satisfies SessionRef),
            'EX',
            LIVE_TTL_SECONDS,
          ),
        ),
      );
    },

    async leave(
      sessionId: string,
      participantId: string,
      reason: LeaveReason,
      now: number,
      requireStatus?: ParticipantStatus,
    ): Promise<LeaveOutcome> {
      const keys = sessionKeys(sessionId);
      const raw = await redis.gwSessionLeave(
        keys.meta,
        keys.participants,
        keys.log,
        keys.frames,
        participantId,
        reason,
        now,
        ENDED_SESSION_TTL_SECONDS,
        requireStatus ?? '',
      );
      const result = leaveResultSchema.parse(raw);
      if (result[0] !== 'left') return { status: result[0] };
      const [, ended, startedAt, ...flat] = result;
      return {
        status: 'left',
        ended: ended === 1,
        startedAt: Number(startedAt),
        others: pairs(flat, 3).map(([pid = '', visitorId = '', priorStatus = 'left']) => ({
          participantId: pid,
          visitorId,
          priorStatus: z.enum(PARTICIPANT_STATUSES).parse(priorStatus),
        })),
      };
    },

    async ack(sessionId: string, participantId: string, now: number) {
      const keys = sessionKeys(sessionId);
      return z
        .enum(['acked', 'already', 'left', 'not_found'])
        .parse(await redis.gwSessionAck(keys.meta, keys.participants, participantId, now));
    },

    /** Returns the other present participants if the participant became `reconnecting`. */
    async disconnect(
      sessionId: string,
      participantId: string,
      now: number,
    ): Promise<PresentParticipant[] | null> {
      const keys = sessionKeys(sessionId);
      const raw = await redis.gwSessionDisconnect(keys.meta, keys.participants, participantId, now);
      const [status, ...flat] = presentListSchema.parse(raw);
      if (status !== 'reconnecting') return null;
      return pairs(flat, 2).map(([pid = '', visitorId = '']) => ({
        participantId: pid,
        visitorId,
      }));
    },

    async resume(sessionId: string, participantId: string, visitorId: string) {
      const keys = sessionKeys(sessionId);
      const result = resumeResultSchema.parse(
        await redis.gwSessionResume(keys.meta, keys.participants, participantId, visitorId),
      );
      if (result[0] === 'not_resumable') return null;
      return { wasReconnecting: result[1] === 1, disconnectedAt: result[2] };
    },

    /** State, mode and participants in one round trip (same hash slot). */
    async context(sessionId: string): Promise<SessionContext | null> {
      const keys = sessionKeys(sessionId);
      const results = await redis
        .pipeline()
        .hmget(
          keys.meta,
          'state',
          'mode',
          'lang',
          'startedAt',
          'initiator',
          'topology',
          'topologyEpoch',
          'topologyState',
          'sfuNodeId',
          'sfuRoomId',
        )
        .hgetall(keys.participants)
        .exec();
      const [metaResult, participantsResult] = results ?? [];
      const meta = z
        .tuple([
          z.enum(['active', 'ended']).nullable(),
          chatModeSchema.nullable(),
          langSchema.nullable(),
          z.string().nullable(),
          z.string().nullable(),
          z.enum(TOPOLOGIES).nullable(),
          z.string().nullable(),
          z.enum(['stable', 'upgrading']).nullable(),
          z.string().nullable(),
          z.string().nullable(),
        ])
        .parse(metaResult?.[1]);
      const [state, mode, lang, startedAt, initiator, topology, epoch, topologyState] = meta;
      const [, , , , , , , , sfuNodeId, sfuRoomId] = meta;
      if (state === null || mode === null || lang === null) return null;
      const participants = new Map<string, ParticipantRecord>();
      const flat = z.record(z.string(), z.string()).parse(participantsResult?.[1]);
      for (const [participantId, json] of Object.entries(flat)) {
        participants.set(participantId, participantRecordSchema.parse(JSON.parse(json)));
      }
      return {
        state,
        mode,
        lang,
        startedAt: Number(startedAt ?? '0'),
        initiator: initiator ?? '',
        participants,
        topology: topology ?? 'mesh',
        topologyEpoch: Number(epoch ?? '0'),
        topologyState: topologyState ?? 'stable',
        sfu:
          sfuNodeId === null || sfuRoomId === null
            ? null
            : { nodeId: sfuNodeId, roomId: Number(sfuRoomId) },
      };
    },

    // --- Topology (Part 11) ---------------------------------------------------------------

    /** Starts a mesh → sfu upgrade; returns its epoch, or why not. */
    async beginUpgrade(
      sessionId: string,
      now: number,
    ): Promise<
      | { status: 'started'; epoch: number }
      | { status: 'not_active' | 'not_video' | 'already' | 'upgrading' }
    > {
      const result = okListSchema.parse(await redis.gwSfuBegin(sessionKeys(sessionId).meta, now));
      const status = z
        .enum(['started', 'not_active', 'not_video', 'already', 'upgrading'])
        .parse(result[0]);
      return status === 'started' ? { status, epoch: Number(result[1]) } : { status };
    },

    /** Records the room of `epoch` and the participants' tokens; false if `epoch` is stale. */
    async assignRoom(
      sessionId: string,
      epoch: number,
      placement: SfuPlacement,
      tokens: Map<string, string>,
    ): Promise<boolean> {
      const keys = sessionKeys(sessionId);
      const result = await redis.gwSfuAssign(
        keys.meta,
        keys.participants,
        epoch,
        placement.nodeId,
        placement.roomId,
        ...[...tokens].flat(),
      );
      return result === 'ok';
    },

    async markTopologyReady(
      sessionId: string,
      participantId: string,
      epoch: number,
    ): Promise<
      | { status: 'pending' | 'stale' | 'not_active' }
      | { status: 'complete'; upgraded: boolean; upgradeStartedAt: number }
    > {
      const keys = sessionKeys(sessionId);
      const result = okListSchema.parse(
        await redis.gwSfuReady(keys.meta, keys.participants, participantId, epoch),
      );
      const status = z.enum(['pending', 'stale', 'not_active', 'complete']).parse(result[0]);
      if (status !== 'complete') return { status };
      return {
        status,
        upgraded: Number(result[1]) === 1,
        upgradeStartedAt: Number(result[2] ?? 0),
      };
    },

    /** Rolls a pending upgrade of `epoch` back; returns the room it had (if any) or null. */
    async rollbackUpgrade(
      sessionId: string,
      epoch: number,
    ): Promise<{ room: SfuPlacement | null } | null> {
      const result = okListSchema.parse(
        await redis.gwSfuRollback(sessionKeys(sessionId).meta, epoch),
      );
      if (result[0] !== 'rolled_back') return null;
      const [, nodeId, roomId] = result;
      return {
        room:
          typeof nodeId === 'string' && nodeId !== '' && roomId !== undefined && roomId !== ''
            ? { nodeId, roomId: Number(roomId) }
            : null,
      };
    },

    /** Failover: a new epoch if the call still uses `from`; null if it moved on already. */
    async beginMove(sessionId: string, from: SfuPlacement): Promise<number | null> {
      const result = okListSchema.parse(
        await redis.gwSfuMove(sessionKeys(sessionId).meta, from.nodeId, from.roomId),
      );
      return result[0] === 'moving' ? Number(result[1]) : null;
    },

    async meta(sessionId: string): Promise<SessionMeta | null> {
      const raw = await redis.hgetall(sessionKeys(sessionId).meta);
      if (raw.mode === undefined) return null;
      return {
        mode: chatModeSchema.parse(raw.mode),
        topology: z.enum(TOPOLOGIES).catch('mesh').parse(raw.topology),
        startedAt: Number(raw.startedAt),
        endedAt: raw.endedAt === undefined ? null : Number(raw.endedAt),
        maxParticipants: Number(raw.maxParticipants ?? '2'),
        commonInterests: z.array(z.string()).parse(JSON.parse(raw.commonInterests ?? '[]')),
      };
    },

    /** Changes a present participant's frame schedule (e.g. raised to the high tier). */
    async setSchedule(
      sessionId: string,
      participantId: string,
      schedule: FrameSchedule,
    ): Promise<boolean> {
      const updated = await redis.gwSessionSchedule(
        sessionKeys(sessionId).participants,
        participantId,
        schedule.frameIntervalMs === null ? '' : String(schedule.frameIntervalMs),
        schedule.maxFrames === null ? '' : String(schedule.maxFrames),
        schedule.tier,
      );
      return updated === 1;
    },

    /** Moderation frames received per participant (`session:{id}:frames`, D-054). */
    async frameStats(sessionId: string): Promise<Map<string, FrameStats>> {
      const flat = await redis.hgetall(sessionKeys(sessionId).frames);
      const stats = new Map<string, FrameStats>();
      for (const [participantId, json] of Object.entries(flat)) {
        const parsed = frameStatsSchema.safeParse(JSON.parse(json));
        if (parsed.success) stats.set(participantId, parsed.data);
      }
      return stats;
    },

    /** Appends to the transcript ring buffer (last `maxMessages`). */
    async appendLog(sessionId: string, entry: ChatMessageOut, maxMessages: number): Promise<void> {
      const { log } = sessionKeys(sessionId);
      await redis
        .multi()
        .rpush(log, JSON.stringify(entry))
        .ltrim(log, -maxMessages, -1)
        .expire(log, LIVE_TTL_SECONDS)
        .exec();
    },

    async readLog(sessionId: string): Promise<ChatMessageOut[]> {
      const raw = await redis.lrange(sessionKeys(sessionId).log, 0, -1);
      return raw.flatMap((json) => {
        const parsed = chatMessageOutSchema.safeParse(JSON.parse(json));
        return parsed.success ? [parsed.data] : [];
      });
    },

    // --- Deadlines (D-047, D-053) ----------------------------------------------------------

    async addDeadline(deadline: Deadline, at: number): Promise<void> {
      await redis.zadd(deadlineKeyOf(deadline.sessionId), at, memberOf(deadline));
    },

    async removeDeadlines(deadlines: Deadline[]): Promise<void> {
      if (deadlines.length === 0) return;
      const pipeline = redis.pipeline();
      for (const d of deadlines) pipeline.zrem(deadlineKeyOf(d.sessionId), memberOf(d));
      await pipeline.exec();
    },

    /**
     * Reads up to `limit` due entries per shard (one pipelined round trip, starting at a random
     * shard), then claims them with ZREM: only entries this call removed are returned, so with
     * many nodes polling each deadline is handled exactly once.
     */
    async claimDueDeadlines(now: number, limit: number): Promise<Deadline[]> {
      const shards = options.deadlineShards;
      const start = Math.floor(Math.random() * shards);
      const order = Array.from({ length: shards }, (_, i) => (start + i) % shards);
      const read = redis.pipeline();
      for (const shard of order) {
        read.zrangebyscore(sessionDeadlinesKey(shard), '-inf', now, 'LIMIT', 0, limit);
      }
      const due = ((await read.exec()) ?? []).flatMap(([, members], index) =>
        Array.isArray(members)
          ? members.map((member) => ({ shard: order[index] ?? 0, member: String(member) }))
          : [],
      );
      if (due.length === 0) return [];

      const claim = redis.pipeline();
      for (const { shard, member } of due) claim.zrem(sessionDeadlinesKey(shard), member);
      const claimed = (await claim.exec()) ?? [];
      return due.flatMap(({ member }, index): Deadline[] => {
        if (claimed[index]?.[1] !== 1) return [];
        const parsed = deadlineMemberSchema.safeParse(member);
        if (!parsed.success) return [];
        const [kind, sessionId, subject] = parsed.data;
        return kind === 'upgrade'
          ? [{ kind, sessionId, epoch: Number(subject) }]
          : [{ kind, sessionId, participantId: subject }];
      });
    },
  };
}

export type SessionStore = ReturnType<typeof createSessionStore>;
