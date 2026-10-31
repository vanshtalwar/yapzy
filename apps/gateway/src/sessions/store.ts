import { randomBytes } from 'node:crypto';

import {
  type MatchPool,
  type Redis,
  sessionKeys,
  visitorSessionKey,
  visitorTicketKey,
} from '@app/redis';
import {
  CHAT_MODES,
  type ChatMode,
  chatModeSchema,
  langSchema,
  participantIdSchema,
  SUPPORTED_LANGS,
  type VisitorState,
} from '@app/shared';
import { LEAVE_REASONS, type LeaveReason } from '@app/shared/jobs';
import { type Result } from 'ioredis';
import { z } from 'zod';

declare module 'ioredis' {
  interface RedisCommander<Context> {
    gwSessionLeave(
      meta: string,
      participants: string,
      log: string,
      participantId: string,
      reason: string,
      nowMs: number,
      ttlSeconds: number,
    ): Result<unknown, Context>;
    gwDelIfField(key: string, field: string, value: string): Result<unknown, Context>;
  }
}

/** Session keys stay this long after the session ends (reports can still reference it). */
export const ENDED_SESSION_TTL_SECONDS = 60 * 60;
/** Refs outlive any realistic session; they are deleted explicitly on leave. */
const REF_TTL_SECONDS = 24 * 60 * 60;

// --- Lua -----------------------------------------------------------------------------------

/**
 * KEYS: meta, participants, log   ARGV: participantId, reason, nowMs, ttlSeconds
 * Marks the participant as left (idempotent). If fewer than 2 participants remain active, the
 * session ends: remaining participants are marked left (no reason), state=ended, all keys get
 * the TTL. Exactly one caller ever observes ended=1.
 * Returns {'not_found'} | {'not_participant'} | {'already_left'} |
 *         {'left', ended(0|1), otherParticipantId, otherVisitorId, ...} (others active before)
 */
const SESSION_LEAVE = `
local state = redis.call('HGET', KEYS[1], 'state')
if not state then return {'not_found'} end
local raw = redis.call('HGET', KEYS[2], ARGV[1])
if not raw then return {'not_participant'} end
local now = tonumber(ARGV[3])
local me = cjson.decode(raw)
if me.leftAt then return {'already_left'} end
me.leftAt = now
me.leaveReason = ARGV[2]
redis.call('HSET', KEYS[2], ARGV[1], cjson.encode(me))

local others = {}
local flat = redis.call('HGETALL', KEYS[2])
for i = 1, #flat, 2 do
  local p = cjson.decode(flat[i + 1])
  if not p.leftAt then
    others[#others + 1] = flat[i]
    others[#others + 1] = p.visitorId
  end
end

local ended = 0
if #others / 2 < 2 and state ~= 'ended' then
  for i = 1, #others, 2 do
    local p = cjson.decode(redis.call('HGET', KEYS[2], others[i]))
    p.leftAt = now
    redis.call('HSET', KEYS[2], others[i], cjson.encode(p))
  end
  redis.call('HSET', KEYS[1], 'state', 'ended', 'endedAt', now)
  for i = 1, 3 do redis.call('EXPIRE', KEYS[i], tonumber(ARGV[4])) end
  ended = 1
end

local result = {'left', ended}
for _, value in ipairs(others) do result[#result + 1] = value end
return result
`;

/** KEYS: key   ARGV: field, value — deletes a JSON ref only if ref[field] == value. */
const DEL_IF_FIELD = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, ref = pcall(cjson.decode, raw)
if ok and ref[ARGV[1]] == ARGV[2] then return redis.call('DEL', KEYS[1]) end
return 0
`;

// --- Schemas -------------------------------------------------------------------------------

/** `visitor:<id>:ticket` — where the visitor's waiting ticket lives. */
export const ticketRefSchema = z.object({
  pool: z.enum(['normal', 'shadow']),
  mode: chatModeSchema,
  lang: langSchema,
  ticketId: z.uuid(),
});
export type TicketRef = z.output<typeof ticketRefSchema>;

/** `visitor:<id>:session` — the visitor's current session and their participant id in it. */
export const sessionRefSchema = z.object({
  sessionId: z.uuid(),
  participantId: participantIdSchema,
});
export type SessionRef = z.output<typeof sessionRefSchema>;

const participantRecordSchema = z.object({
  visitorId: z.string().min(1),
  joinedAt: z.number(),
  leftAt: z.number().optional(),
  leaveReason: z.enum(LEAVE_REASONS).optional(),
});
export type ParticipantRecord = z.output<typeof participantRecordSchema>;

const sessionStateSchema = z.enum(['active', 'ended']);

const leaveResultSchema = z.union([
  z.tuple([z.enum(['not_found', 'not_participant', 'already_left'])]),
  z.tuple([z.literal('left'), z.union([z.literal(0), z.literal(1)])]).rest(z.string()),
]);

export interface ActiveParticipant {
  participantId: string;
  visitorId: string;
}

export type LeaveOutcome =
  | { status: 'not_found' | 'not_participant' | 'already_left' }
  | { status: 'left'; ended: boolean; others: ActiveParticipant[] };

export interface SessionContext {
  state: 'active' | 'ended';
  mode: ChatMode;
  participants: Map<string, ParticipantRecord>;
}

export interface SessionMeta {
  mode: ChatMode;
  startedAt: number;
  endedAt: number | null;
  maxParticipants: number;
  commonInterests: string[];
}

/** Random, unguessable per-session id shown to other participants instead of visitor ids. */
export function newParticipantId(): string {
  return `p${randomBytes(9).toString('base64url')}`;
}

export function createSessionStore(redis: Redis) {
  redis.defineCommand('gwSessionLeave', { numberOfKeys: 3, lua: SESSION_LEAVE });
  redis.defineCommand('gwDelIfField', { numberOfKeys: 1, lua: DEL_IF_FIELD });

  async function getRef<T>(key: string, schema: z.ZodType<T>): Promise<T | null> {
    const raw = await redis.get(key);
    if (raw === null) return null;
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null; // corrupt ref = no ref
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
      await redis.set(visitorTicketKey(visitorId), JSON.stringify(ref), 'EX', REF_TTL_SECONDS);
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
      commonInterests: string[];
      participants: ActiveParticipant[];
      now: number;
    }): Promise<void> {
      const keys = sessionKeys(input.sessionId);
      const multi = redis.multi().hset(keys.meta, {
        mode: input.mode,
        topology: 'mesh',
        maxParticipants: '2',
        startedAt: String(input.now),
        commonInterests: JSON.stringify(input.commonInterests),
        state: 'active',
      });
      for (const { participantId, visitorId } of input.participants) {
        const record: ParticipantRecord = { visitorId, joinedAt: input.now };
        multi.hset(keys.participants, participantId, JSON.stringify(record));
      }
      await multi.exec();

      await Promise.all(
        input.participants.map(({ participantId, visitorId }) =>
          redis.set(
            visitorSessionKey(visitorId),
            JSON.stringify({ sessionId: input.sessionId, participantId } satisfies SessionRef),
            'EX',
            REF_TTL_SECONDS,
          ),
        ),
      );
    },

    async leave(
      sessionId: string,
      participantId: string,
      reason: LeaveReason,
      now: number,
    ): Promise<LeaveOutcome> {
      const keys = sessionKeys(sessionId);
      const raw = await redis.gwSessionLeave(
        keys.meta,
        keys.participants,
        keys.log,
        participantId,
        reason,
        now,
        ENDED_SESSION_TTL_SECONDS,
      );
      const result = leaveResultSchema.parse(raw);
      if (result[0] !== 'left') return { status: result[0] };
      const [, ended, ...flat] = result;
      const others: ActiveParticipant[] = [];
      for (let i = 0; i + 1 < flat.length; i += 2) {
        others.push({ participantId: flat[i] ?? '', visitorId: flat[i + 1] ?? '' });
      }
      return { status: 'left', ended: ended === 1, others };
    },

    /** State, mode and participants in one round trip (same hash slot). */
    async context(sessionId: string): Promise<SessionContext | null> {
      const keys = sessionKeys(sessionId);
      const results = await redis
        .pipeline()
        .hmget(keys.meta, 'state', 'mode')
        .hgetall(keys.participants)
        .exec();
      const [metaResult, participantsResult] = results ?? [];
      const [state, mode] = z
        .tuple([sessionStateSchema.nullable(), chatModeSchema.nullable()])
        .parse(metaResult?.[1]);
      if (state === null || mode === null) return null;
      const participants = new Map<string, ParticipantRecord>();
      const flat = z.record(z.string(), z.string()).parse(participantsResult?.[1]);
      for (const [participantId, json] of Object.entries(flat)) {
        participants.set(participantId, participantRecordSchema.parse(JSON.parse(json)));
      }
      return { state, mode, participants };
    },

    async meta(sessionId: string): Promise<SessionMeta | null> {
      const raw = await redis.hgetall(sessionKeys(sessionId).meta);
      if (raw.mode === undefined) return null;
      return {
        mode: chatModeSchema.parse(raw.mode),
        startedAt: Number(raw.startedAt),
        endedAt: raw.endedAt === undefined ? null : Number(raw.endedAt),
        maxParticipants: Number(raw.maxParticipants ?? '2'),
        commonInterests: z.array(z.string()).parse(JSON.parse(raw.commonInterests ?? '[]')),
      };
    },

    /** Appends to the transcript ring buffer (last TRANSCRIPT_MAX_MESSAGES). */
    async appendLog(sessionId: string, entry: object, maxMessages: number): Promise<void> {
      const { log } = sessionKeys(sessionId);
      await redis.multi().rpush(log, JSON.stringify(entry)).ltrim(log, -maxMessages, -1).exec();
    },
  };
}

export type SessionStore = ReturnType<typeof createSessionStore>;

/** Every (pool, mode, lang) combination — the sweeper visits each matchmaking tag. */
export function allMatchDimensions(): {
  pool: MatchPool;
  mode: ChatMode;
  lang: (typeof SUPPORTED_LANGS)[number];
}[] {
  return (['normal', 'shadow'] as const).flatMap((pool) =>
    CHAT_MODES.flatMap((mode) => SUPPORTED_LANGS.map((lang) => ({ pool, mode, lang }))),
  );
}
