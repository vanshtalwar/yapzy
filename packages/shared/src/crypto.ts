// Server-only (node:crypto). Import via "@app/shared/crypto"; never re-export from index.ts,
// which must stay browser-safe.
import { createHmac } from 'node:crypto';

/**
 * HMAC-SHA256 (hex) of an identifier such as a raw IP or device ID. The pepper keeps hashes
 * unlinkable to the raw value without server secrets, so they can be stored and compared
 * (bans, rate limits) while the raw value is never persisted.
 */
export function hmacHash(value: string, pepper: string): string {
  if (pepper.length === 0) throw new Error('hmacHash: pepper must not be empty');
  return createHmac('sha256', pepper).update(value, 'utf8').digest('hex');
}
