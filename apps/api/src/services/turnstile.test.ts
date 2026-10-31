import { describe, expect, it } from 'vitest';

import { createCloudflareTurnstileVerifier, TurnstileUnavailableError } from './turnstile.ts';

function verifierReturning(
  response: Response | Error,
  options: { expectedHostnames?: string[]; strict?: boolean } = {},
) {
  const calls: { url: string; body: string }[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push({ url, body: init?.body instanceof URLSearchParams ? init.body.toString() : '' });
    return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
  };
  return {
    calls,
    verifier: createCloudflareTurnstileVerifier({ secretKey: 'secret-x', fetchImpl, ...options }),
  };
}

describe('Cloudflare Turnstile verifier', () => {
  it('posts the secret and token to siteverify (without the visitor IP)', async () => {
    const { calls, verifier } = verifierReturning(Response.json({ success: true }));
    expect(await verifier.verify('token-y')).toEqual({ success: true, errorCodes: [] });
    expect(calls[0]?.url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    const form = new URLSearchParams(calls[0]?.body);
    expect(form.get('secret')).toBe('secret-x');
    expect(form.get('response')).toBe('token-y');
    expect(form.has('remoteip')).toBe(false);
  });

  it('reports failed checks with their error codes', async () => {
    const { verifier } = verifierReturning(
      Response.json({ success: false, 'error-codes': ['timeout-or-duplicate'] }),
    );
    expect(await verifier.verify('t')).toEqual({
      success: false,
      errorCodes: ['timeout-or-duplicate'],
    });
  });

  it('checks the hostname and the widget action', async () => {
    const result = (body: Record<string, unknown>, options = {}) =>
      verifierReturning(Response.json({ success: true, ...body }), options).verifier.verify('t');
    const hosts = { expectedHostnames: ['randomchat.example'] };
    expect(await result({ hostname: 'RandomChat.example', action: 'session' }, hosts)).toEqual({
      success: true,
      errorCodes: [],
    });
    expect(await result({ hostname: 'evil.example', action: 'session' }, hosts)).toEqual({
      success: false,
      errorCodes: ['hostname-mismatch'],
    });
    expect(await result({ hostname: 'randomchat.example', action: 'login' }, hosts)).toEqual({
      success: false,
      errorCodes: ['action-mismatch'],
    });
    // Development: Cloudflare's test keys answer hostname example.com, no action.
    const testKey = { hostname: 'example.com', metadata: { result_with_testing_key: true } };
    expect((await result(testKey)).success).toBe(true);
    // Production: the action must be echoed and testing-key results are refused.
    expect(await result(testKey, { strict: true })).toEqual({
      success: false,
      errorCodes: ['action-missing'],
    });
    expect(await result({ ...testKey, action: 'session' }, { strict: true })).toEqual({
      success: false,
      errorCodes: ['testing-key'],
    });
  });

  it('distinguishes an unreachable or misbehaving Cloudflare from a failed check', async () => {
    for (const response of [
      new Error('ECONNRESET'),
      new Response('oops', { status: 500 }),
      Response.json({ unexpected: true }),
    ]) {
      const { verifier } = verifierReturning(response);
      await expect(verifier.verify('t')).rejects.toBeInstanceOf(TurnstileUnavailableError);
    }
  });
});
