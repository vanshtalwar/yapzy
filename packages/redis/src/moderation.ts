import { z } from 'zod';

/**
 * `risk:<visitorId>` — written by the API at session creation and by the worker on reports /
 * flags; read by the gateway at match time (risk tier → frame-sampling interval, D-054).
 * Times are ms epoch.
 */
export const riskProfileEntrySchema = z.object({
  firstSeenAt: z.number().nullable(),
  flaggedUntil: z.number().nullable(),
  lastReportedAt: z.number().nullable(),
});
export type RiskProfileEntry = z.output<typeof riskProfileEntrySchema>;

/** The risk profile outlives visitor sessions so recent flags still count next time. */
export const RISK_PROFILE_TTL_SECONDS = 8 * 24 * 60 * 60;

/** Cached trust scores are refreshed from Postgres at least this often. */
export const TRUST_CACHE_TTL_SECONDS = 60 * 60;

/** `session:{id}:frames` field value: moderation frame uploads of one participant. */
export const frameStatsSchema = z.object({
  received: z.number().int().min(0),
  /** ms epoch of the last accepted frame. */
  lastAt: z.number(),
});
export type FrameStats = z.output<typeof frameStatsSchema>;
