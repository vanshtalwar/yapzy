// Background job contracts shared by producers (gateway) and consumers (worker).
// Import via "@app/shared/jobs".
import { z } from 'zod';

import { chatModeSchema } from './schemas.ts';
import { participantIdSchema, sessionIdSchema } from './socket/schemas.ts';

export const QUEUE_NAMES = {
  SESSION_LOG: 'session-log',
  /** A sampled video frame to hash-match and classify (D-054). */
  CLASSIFY_FRAME: 'classify-frame',
  /** Persist a moderation event (text filter, client signal) and apply its trust change. */
  MODERATION_EVENT: 'moderation-event',
  /** A report was filed: trust change, risk flag, automatic shadow ban past the threshold. */
  REPORT_FILED: 'report-filed',
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
        /** Moderation frame sampling: what was assigned vs received (missing-upload check). */
        frames: z
          .object({
            intervalMs: z.number().int().positive().nullable(),
            maxFrames: z.number().int().positive().nullable(),
            received: z.number().int().min(0),
          })
          .optional(),
      }),
    )
    .min(1),
});

export type SessionLogJob = z.output<typeof sessionLogJobSchema>;

/** Mirrors the Prisma `ModerationSource` / `ModerationAction` enums. */
export const MODERATION_SOURCES = [
  'CLIENT_NSFW',
  'SERVER_CLASSIFIER',
  'TEXT_FILTER',
  'HASH_MATCH',
  'REPORT_THRESHOLD',
] as const;
export const MODERATION_ACTIONS = [
  'NONE',
  'MESSAGE_BLOCKED',
  'TRUST_DECREASED',
  'SHADOW_BANNED',
  'BANNED',
  'ESCALATED',
] as const;

export const classifyFrameJobSchema = z.object({
  /** Key in the frames bucket (1-day lifecycle). */
  storageKey: z.string().min(1).max(512),
  sessionId: sessionIdSchema,
  participantId: participantIdSchema,
  visitorId: z.string().min(1),
  receivedAt: z.iso.datetime(),
});
export type ClassifyFrameJob = z.output<typeof classifyFrameJobSchema>;

export const moderationEventJobSchema = z.object({
  visitorId: z.string().min(1),
  sessionId: sessionIdSchema.nullable(),
  source: z.enum(MODERATION_SOURCES),
  /** e.g. a text-filter reason or a classifier label. */
  label: z.string().min(1).max(64),
  score: z.number().min(0).max(1),
  action: z.enum(MODERATION_ACTIONS),
  /** Trust change to apply (Part 8 rules); none for unverified client signals. */
  trustEvent: z.enum(['text_violation']).nullable(),
  at: z.iso.datetime(),
});
export type ModerationEventJob = z.output<typeof moderationEventJobSchema>;

export const reportFiledJobSchema = z.object({
  reportId: z.uuid(),
  reportedId: z.string().min(1),
  sessionId: sessionIdSchema,
  at: z.iso.datetime(),
});
export type ReportFiledJob = z.output<typeof reportFiledJobSchema>;
