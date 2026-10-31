import { randomUUID } from 'node:crypto';

import { z } from 'zod';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export interface TurnstileResult {
  success: boolean;
  errorCodes: string[];
}

export interface TurnstileVerifier {
  verify(token: string): Promise<TurnstileResult>;
}

/** Cloudflare could not be asked (network, timeout, unexpected response) — not a failed check. */
export class TurnstileUnavailableError extends Error {
  constructor(reason: string, options?: { cause: unknown }) {
    super(`Turnstile siteverify unavailable: ${reason}`, options);
    this.name = 'TurnstileUnavailableError';
  }
}

const siteverifyResponseSchema = z.object({
  success: z.boolean(),
  'error-codes': z.array(z.string()).default([]),
});

export interface CloudflareTurnstileOptions {
  secretKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Real siteverify call. In development the always-pass test secret is used, so this still makes
 * a network request. The visitor's IP is deliberately not sent (`remoteip` is optional).
 */
export function createCloudflareTurnstileVerifier({
  secretKey,
  timeoutMs = 5_000,
  fetchImpl = fetch,
}: CloudflareTurnstileOptions): TurnstileVerifier {
  return {
    async verify(token) {
      const body = new URLSearchParams({
        secret: secretKey,
        response: token,
        idempotency_key: randomUUID(),
      });

      let response: Response;
      try {
        response = await fetchImpl(SITEVERIFY_URL, {
          method: 'POST',
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new TurnstileUnavailableError('request failed', { cause: error });
      }
      if (!response.ok) throw new TurnstileUnavailableError(`HTTP ${String(response.status)}`);

      const parsed = siteverifyResponseSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) throw new TurnstileUnavailableError('unexpected response body');
      return { success: parsed.data.success, errorCodes: parsed.data['error-codes'] };
    },
  };
}
