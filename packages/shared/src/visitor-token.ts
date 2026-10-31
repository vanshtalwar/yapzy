// Server-only: visitor JWTs are issued by the API and verified by the API and the gateway.
// Import via "@app/shared/visitor-token".
import { randomUUID } from 'node:crypto';

import { errors, jwtVerify, SignJWT } from 'jose';

const ALGORITHM = 'HS256';
const ISSUER = 'randomchat-api';
const AUDIENCE = 'randomchat';

export interface VisitorTokenClaims {
  visitorId: string;
  /** Unique token id; lets later parts revoke a single token. */
  jti: string;
  expiresAt: Date;
}

export type VisitorTokenErrorKind = 'expired' | 'invalid';

export class VisitorTokenError extends Error {
  readonly kind: VisitorTokenErrorKind;

  constructor(kind: VisitorTokenErrorKind) {
    super(kind === 'expired' ? 'Visitor token expired' : 'Visitor token invalid');
    this.name = 'VisitorTokenError';
    this.kind = kind;
  }
}

export interface VisitorTokenService {
  issue(visitorId: string): Promise<{ token: string; expiresAt: Date }>;
  /** Throws VisitorTokenError; never returns partially verified claims. */
  verify(token: string): Promise<VisitorTokenClaims>;
}

export interface VisitorTokenOptions {
  secret: string;
  ttlSeconds: number;
  /** Injected for tests; defaults to the system clock. */
  now?: () => Date;
}

export function createVisitorTokenService({
  secret,
  ttlSeconds,
  now = () => new Date(),
}: VisitorTokenOptions): VisitorTokenService {
  if (secret.length < 32) throw new Error('JWT secret must be at least 32 characters');
  const key = new TextEncoder().encode(secret);

  return {
    async issue(visitorId) {
      const issuedAt = now();
      const expiresAt = new Date(issuedAt.getTime() + ttlSeconds * 1000);
      const token = await new SignJWT({})
        .setProtectedHeader({ alg: ALGORITHM, typ: 'JWT' })
        .setSubject(visitorId)
        .setJti(randomUUID())
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt(issuedAt)
        .setExpirationTime(expiresAt)
        .sign(key);
      return { token, expiresAt };
    },

    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, key, {
          algorithms: [ALGORITHM],
          issuer: ISSUER,
          audience: AUDIENCE,
          currentDate: now(),
          requiredClaims: ['sub', 'jti', 'exp', 'iat'],
        });
        if (
          typeof payload.sub !== 'string' ||
          typeof payload.jti !== 'string' ||
          typeof payload.exp !== 'number'
        ) {
          throw new VisitorTokenError('invalid');
        }
        return {
          visitorId: payload.sub,
          jti: payload.jti,
          expiresAt: new Date(payload.exp * 1000),
        };
      } catch (error) {
        if (error instanceof VisitorTokenError) throw error;
        if (error instanceof errors.JWTExpired) throw new VisitorTokenError('expired');
        throw new VisitorTokenError('invalid');
      }
    },
  };
}
