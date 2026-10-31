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
  hostname: z.string().optional(),
  action: z.string().optional(),
  metadata: z.object({ result_with_testing_key: z.boolean().optional() }).optional(),
});

/** The `action` the web widget renders with (`components/turnstile.tsx`). */
export const TURNSTILE_ACTION = 'session';

export interface CloudflareTurnstileOptions {
  secretKey: string;
  /** Hostnames the widget may run on (siteverify `hostname`); empty = not checked. */
  expectedHostnames?: readonly string[];
  /**
   * Production (DEPLOY_ENV=production): the token must carry the `session` action and must not
   * come from a Cloudflare testing key. Test keys echo no action and hostname `example.com`,
   * so development leaves this off.
   */
  strict?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Real siteverify call. In development the always-pass test secret is used, so this still makes
 * a network request. The visitor's IP is deliberately not sent (`remoteip` is optional).
 */
export function createCloudflareTurnstileVerifier({
  secretKey,
  expectedHostnames = [],
  strict = false,
  timeoutMs = 5_000,
  fetchImpl = fetch,
}: CloudflareTurnstileOptions): TurnstileVerifier {
  const hostnames = new Set(expectedHostnames.map((hostname) => hostname.toLowerCase()));
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
      const result = parsed.data;
      if (!result.success) return { success: false, errorCodes: result['error-codes'] };
      // A token solved on another site (or for another widget) is not proof for this one.
      if (hostnames.size > 0 && !hostnames.has(result.hostname?.toLowerCase() ?? '')) {
        return { success: false, errorCodes: ['hostname-mismatch'] };
      }
      if (result.action !== undefined && result.action !== TURNSTILE_ACTION) {
        return { success: false, errorCodes: ['action-mismatch'] };
      }
      if (strict && result.action === undefined) {
        return { success: false, errorCodes: ['action-missing'] };
      }
      if (strict && result.metadata?.result_with_testing_key === true) {
        return { success: false, errorCodes: ['testing-key'] };
      }
      return { success: true, errorCodes: [] };
    },
  };
}
