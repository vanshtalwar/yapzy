import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** The only Janus plugin our tokens are valid for. */
export const VIDEOROOM_PLUGIN = 'janus.plugin.videoroom';

/** Join tokens are valid this long (D-051); clients refresh them for long calls. */
export const JANUS_TOKEN_TTL_SECONDS = 10 * 60;

export interface JanusTokenOptions {
  /** Janus `token_auth_secret` (JANUS_TOKEN_SECRET). */
  secret: string;
  /** Unix seconds after which Janus refuses the token. */
  expiresAt: number;
  /**
   * Makes the token unique. A room's `allowed` list holds one token per participant, so
   * removing a participant's token must never remove someone else's.
   */
  nonce?: string;
}

/**
 * A Janus signed token as janus/auth.c verifies it with `token_auth_hash = "sha256"`:
 *
 *   <expiry>,janus,janus.plugin.videoroom,n=<nonce>:<base64(HMAC-SHA256(secret, data))>
 *
 * Janus checks the expiry and signature on every request (create, attach, message, trickle,
 * keepalive) and the plugin descriptor on attach, so the token opens the VideoRoom plugin and
 * nothing else. The nonce is just another descriptor; Janus ignores ones it doesn't know.
 */
export function signJanusToken({
  secret,
  expiresAt,
  nonce = randomBytes(12).toString('base64url'),
}: JanusTokenOptions): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(nonce)) throw new Error('Invalid token nonce');
  const data = `${String(Math.floor(expiresAt))},janus,${VIDEOROOM_PLUGIN},n=${nonce}`;
  return `${data}:${createHmac('sha256', secret).update(data).digest('base64')}`;
}

/** Expiry (unix seconds) of a token we signed, or null if it isn't one. For tests and logs. */
export function janusTokenExpiry(token: string, secret: string): number | null {
  const [data, signature] = token.split(':');
  if (data === undefined || signature === undefined) return null;
  const expected = Buffer.from(createHmac('sha256', secret).update(data).digest('base64'));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  const expiry = Number(data.split(',')[0]);
  return Number.isInteger(expiry) ? expiry : null;
}
