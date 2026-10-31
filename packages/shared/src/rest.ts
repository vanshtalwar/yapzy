// REST contract between apps/api and its clients (web, admin, bots). Browser-safe.
import { z } from 'zod';

import { ErrorCode } from './errors.ts';

export const sessionRequestSchema = z.object({
  turnstileToken: z.string().min(1).max(2048),
  ageConfirmed: z.boolean(),
  tosVersion: z.string().min(1).max(32),
  /** Random UUID the browser keeps in localStorage; only its HMAC is stored. */
  deviceId: z.uuid(),
});
export type SessionRequest = z.input<typeof sessionRequestSchema>;

export const sessionResponseSchema = z.object({
  token: z.string(),
  visitorId: z.uuid(),
  expiresAt: z.iso.datetime(),
});
export type SessionResponse = z.output<typeof sessionResponseSchema>;

export const publicConfigSchema = z.object({
  tosVersion: z.string(),
  maxMessageLength: z.number().int(),
  maxInterests: z.number().int(),
  supportedLangs: z.array(z.string()),
  features: z.object({ video: z.boolean(), reports: z.boolean() }),
});
export type PublicConfig = z.output<typeof publicConfigSchema>;

export const onlineStatsSchema = z.object({ online: z.number().int().nonnegative() });

export const iceServerSchema = z.object({
  urls: z.array(z.string()),
  username: z.string().optional(),
  credential: z.string().optional(),
});
export const turnCredentialsSchema = z.object({
  iceServers: z.array(iceServerSchema),
  ttlSeconds: z.number().int(),
});
export type TurnCredentials = z.output<typeof turnCredentialsSchema>;

/** Every API error: `{ error: { code, message, requestId, ...details } }`. */
export const errorEnvelopeSchema = z.object({
  error: z.looseObject({
    code: z.enum(ErrorCode),
    message: z.string(),
    requestId: z.string(),
    /** BANNED: ISO date or null (permanent). */
    expiresAt: z.iso.datetime().nullable().optional(),
    /** TOS_OUTDATED: the version clients must accept now. */
    tosVersion: z.string().optional(),
  }),
});
export type ErrorEnvelope = z.output<typeof errorEnvelopeSchema>;
