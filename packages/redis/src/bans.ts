import { z } from 'zod';

/** Value of `ban:visitor|device|ip:*` cache keys; `expiresAt` null = permanent. */
export const banCacheEntrySchema = z.object({
  banId: z.string().min(1),
  type: z.enum(['HARD', 'SHADOW']),
  expiresAt: z.iso.datetime().nullable(),
});

export type BanCacheEntry = z.output<typeof banCacheEntrySchema>;
