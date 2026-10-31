import { z } from 'zod';

/**
 * Value of `ban:visitor|device|ip:*` cache keys. "Not banned" is cached too (short TTL) so the
 * hot path doesn't hit Postgres on every session/connection. `expiresAt` null = permanent.
 */
export const banCacheEntrySchema = z.discriminatedUnion('banned', [
  z.object({ banned: z.literal(false) }),
  z.object({
    banned: z.literal(true),
    banId: z.string().min(1),
    type: z.enum(['HARD', 'SHADOW']),
    expiresAt: z.iso.datetime().nullable(),
  }),
]);

export type BanCacheEntry = z.output<typeof banCacheEntrySchema>;

/** Negative entries are short-lived; ban writers also overwrite the cache explicitly. */
export const BAN_CACHE_NEGATIVE_TTL_SECONDS = 60;

/** Positive entries are re-validated at least hourly in case a revocation missed the cache. */
export const BAN_CACHE_MAX_TTL_SECONDS = 60 * 60;
