// Background job contracts shared by producers (gateway) and consumers (worker).
// Import via "@app/shared/jobs".
import { z } from 'zod';

import { chatModeSchema } from './schemas.ts';
import { participantIdSchema, sessionIdSchema } from './socket/schemas.ts';

export const QUEUE_NAMES = {
  SESSION_LOG: 'session-log',
} as const;

/**
 * BullMQ key prefix. The braces make every queue key share one Redis Cluster hash slot, which
 * BullMQ requires in cluster mode.
 */
export const BULLMQ_PREFIX = '{bull}';

/** Mirrors the Prisma `LeaveReason` enum (the worker asserts they match at compile time). */
export const LEAVE_REASONS = [
  'SKIP',
  'STOP',
  'DISCONNECT',
  'RTC_FAILED',
  'REPORTED',
  'BANNED',
  'SERVER_RESTART',
  /** Never sent `match:ack` (ghost tab, D-047). */
  'MATCH_TIMEOUT',
] as const;
export type LeaveReason = (typeof LEAVE_REASONS)[number];

export const sessionLogJobSchema = z.object({
  sessionId: sessionIdSchema,
  mode: chatModeSchema,
  topology: z.enum(['mesh', 'sfu']),
  maxParticipants: z.number().int().min(2).max(16),
  commonInterests: z.array(z.string()),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime(),
  participants: z
    .array(
      z.object({
        participantId: participantIdSchema,
        visitorId: z.string().min(1),
        joinedAt: z.iso.datetime(),
        leftAt: z.iso.datetime().nullable(),
        /** null when the participant stayed until the session ended because others left. */
        leaveReason: z.enum(LEAVE_REASONS).nullable(),
      }),
    )
    .min(1),
});

export type SessionLogJob = z.output<typeof sessionLogJobSchema>;
