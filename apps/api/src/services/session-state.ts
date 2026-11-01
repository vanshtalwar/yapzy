import {
  type FrameStats,
  frameStatsSchema,
  type Redis,
  sessionKeys,
  visitorSessionKey,
} from '@app/redis';
import { type Result } from 'ioredis';
import { z } from 'zod';

/**
 * Read-only view of the gateway's session keys (`session:{id}:*`, kept 1 h after the end).
 * Only the fields the API needs are parsed; the gateway owns the full format.
 */
const participantSchema = z.looseObject({
  visitorId: z.string().min(1),
  status: z.enum(['pending', 'active', 'reconnecting', 'left']),
  joinedAt: z.number().optional(),
  leftAt: z.number().optional(),
  leaveReason: z.string().optional(),
  frameIntervalMs: z.number().int().positive().nullable().optional(),
  maxFrames: z.number().int().positive().nullable().optional(),
});
export type SessionParticipant = z.output<typeof participantSchema>;

const transcriptEntrySchema = z.object({
  from: z.string(),
  id: z.string(),
  text: z.string(),
  at: z.string(),
});
export type TranscriptEntry = z.output<typeof transcriptEntrySchema>;

const visitorSessionSchema = z.object({ sessionId: z.string(), participantId: z.string() });

/**
 * KEYS: frames   ARGV: participantId, nowMs, minGapMs, maxFrames (0 = no limit), ttlSeconds
 * Accepts a frame only if the participant's schedule allows it; counts it atomically.
 */
const FRAME_ACCEPT = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
local now = tonumber(ARGV[2])
local received = 0
local lastAt = nil
if raw then
  local stats = cjson.decode(raw)
  received = stats.received
  lastAt = stats.lastAt
end
local maxFrames = tonumber(ARGV[4])
if maxFrames > 0 and received >= maxFrames then return {'limit'} end
if lastAt and now - lastAt < tonumber(ARGV[3]) then return {'too_soon'} end
received = received + 1
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode({ received = received, lastAt = now }))
if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[5])) end
return {'ok', received}
`;

declare module 'ioredis' {
  interface RedisCommander<Context> {
    apiFrameAccept(
      frames: string,
      participantId: string,
      nowMs: number,
      minGapMs: number,
      maxFrames: number,
      ttlSeconds: number,
    ): Result<unknown, Context>;
  }
}

/** Frames of a live session are kept counted for a day at most. */
const LIVE_FRAMES_TTL_SECONDS = 24 * 60 * 60;

export function createSessionState(redis: Redis) {
  redis.defineCommand('apiFrameAccept', { numberOfKeys: 1, lua: FRAME_ACCEPT });

  return {
    async participants(sessionId: string): Promise<Map<string, SessionParticipant>> {
      const flat = await redis.hgetall(sessionKeys(sessionId).participants);
      const result = new Map<string, SessionParticipant>();
      for (const [participantId, json] of Object.entries(flat)) {
        const parsed = participantSchema.safeParse(JSON.parse(json));
        if (parsed.success) result.set(participantId, parsed.data);
      }
      return result;
    },

    async meta(sessionId: string): Promise<{ mode: string | null; state: string | null }> {
      const [mode, state] = await redis.hmget(sessionKeys(sessionId).meta, 'mode', 'state');
      return { mode: mode ?? null, state: state ?? null };
    },

    async transcript(sessionId: string): Promise<TranscriptEntry[]> {
      const raw = await redis.lrange(sessionKeys(sessionId).log, 0, -1);
      return raw.flatMap((json) => {
        const parsed = transcriptEntrySchema.safeParse(JSON.parse(json));
        return parsed.success ? [parsed.data] : [];
      });
    },

    /** The visitor's current session and participant id, if any. */
    async currentSession(visitorId: string) {
      const raw = await redis.get(visitorSessionKey(visitorId));
      if (raw === null) return null;
      const parsed = visitorSessionSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    },

    async acceptFrame(input: {
      sessionId: string;
      participantId: string;
      now: number;
      minGapMs: number;
      maxFrames: number | null;
    }): Promise<'ok' | 'too_soon' | 'limit'> {
      const result = z
        .union([z.tuple([z.literal('ok'), z.number()]), z.tuple([z.enum(['too_soon', 'limit'])])])
        .parse(
          await redis.apiFrameAccept(
            sessionKeys(input.sessionId).frames,
            input.participantId,
            input.now,
            input.minGapMs,
            input.maxFrames ?? 0,
            LIVE_FRAMES_TTL_SECONDS,
          ),
        );
      return result[0];
    },

    async frameStats(sessionId: string, participantId: string): Promise<FrameStats | null> {
      const raw = await redis.hget(sessionKeys(sessionId).frames, participantId);
      if (raw === null) return null;
      return frameStatsSchema.parse(JSON.parse(raw));
    },
  };
}

export type SessionState = ReturnType<typeof createSessionState>;
