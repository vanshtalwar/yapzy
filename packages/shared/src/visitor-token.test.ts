import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';

import { createVisitorTokenService, VisitorTokenError } from './visitor-token.ts';

const SECRET = 'test-secret-that-is-at-least-32-characters-long';
const T0 = new Date('2026-10-31T12:00:00.000Z');

function serviceAt(date: Date, secret = SECRET) {
  return createVisitorTokenService({ secret, ttlSeconds: 3600, now: () => date });
}

async function kindOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  return error instanceof VisitorTokenError ? error.kind : 'no VisitorTokenError';
}

describe('visitor tokens', () => {
  it('issues tokens that verify to the same visitor', async () => {
    const { token, expiresAt } = await serviceAt(T0).issue('visitor-1');
    expect(expiresAt.toISOString()).toBe('2026-10-31T13:00:00.000Z');
    const claims = await serviceAt(new Date(T0.getTime() + 60_000)).verify(token);
    expect(claims.visitorId).toBe('visitor-1');
    expect(claims.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(claims.expiresAt).toEqual(expiresAt);
  });

  it('reports expired tokens distinctly', async () => {
    const { token } = await serviceAt(T0).issue('visitor-1');
    expect(await kindOf(serviceAt(new Date(T0.getTime() + 3_601_000)).verify(token))).toBe(
      'expired',
    );
  });

  it('rejects tampered, foreign-key and malformed tokens as invalid', async () => {
    const { token } = await serviceAt(T0).issue('visitor-1');
    const [header, payload, signature] = token.split('.') as [string, string, string];
    const forgedPayload = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), sub: 'x' }),
    ).toString('base64url');

    const verifier = serviceAt(T0);
    expect(await kindOf(verifier.verify(`${header}.${forgedPayload}.${signature}`))).toBe(
      'invalid',
    );
    expect(await kindOf(serviceAt(T0, `${SECRET}-other`).verify(token))).toBe('invalid');
    expect(await kindOf(verifier.verify('not-a-jwt'))).toBe('invalid');
  });

  it('rejects tokens without the expected issuer/audience or using another algorithm', async () => {
    const key = new TextEncoder().encode(SECRET);
    const noAudience = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('visitor-1')
      .setJti('j')
      .setIssuer('randomchat-api')
      .setIssuedAt(T0)
      .setExpirationTime(new Date(T0.getTime() + 60_000))
      .sign(key);
    expect(await kindOf(serviceAt(T0).verify(noAudience))).toBe('invalid');

    const hs512 = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS512' })
      .setSubject('visitor-1')
      .setJti('j')
      .setIssuer('randomchat-api')
      .setAudience('randomchat')
      .setIssuedAt(T0)
      .setExpirationTime(new Date(T0.getTime() + 60_000))
      .sign(key);
    expect(await kindOf(serviceAt(T0).verify(hs512))).toBe('invalid');
  });

  it('refuses short secrets', () => {
    expect(() => createVisitorTokenService({ secret: 'short', ttlSeconds: 60 })).toThrow();
  });
});
