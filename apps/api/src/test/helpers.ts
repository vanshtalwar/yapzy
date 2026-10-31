import { randomInt, randomUUID } from 'node:crypto';

import { createPrismaClient } from '@app/db';
import { apiEnv, createEnv, databaseTestEnv } from '@app/env';
import { createTestRedis } from '@app/redis/testing';

import { buildApp } from '../app.ts';
import { type AppDeps, type Clock } from '../deps.ts';
import { TurnstileUnavailableError, type TurnstileVerifier } from '../services/turnstile.ts';

const { DATABASE_URL_TEST } = createEnv(databaseTestEnv, { service: 'api-tests' });

/** Fixed test configuration; only the test database URL comes from the developer's .env. */
export const testConfig = createEnv(apiEnv, {
  service: 'api-tests',
  source: {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: DATABASE_URL_TEST,
    REDIS_URL: 'redis://localhost:6379/14',
    IP_HASH_PEPPER: 'test-ip-pepper-0123456789',
    DEVICE_HASH_PEPPER: 'test-device-pepper-0123456789',
    CORS_ORIGINS: 'http://localhost:3000',
    // Set on purpose: it must be ignored outside NODE_ENV=development.
    RATE_LIMIT_DISABLED: 'true',
    JWT_SECRET: 'test-jwt-secret-0123456789abcdef0123456789',
    JWT_TTL_SECONDS: '3600',
    TOS_VERSION: 'test-tos',
    TURNSTILE_SECRET_KEY: 'unused-in-tests',
    TURN_SECRET: 'test-turn-secret-0123',
    TURN_HOST: 'turn.test',
    TURN_PORT: '3478',
    TURN_CREDENTIAL_TTL_SECONDS: '600',
    STUN_URLS: 'stun:stun.test:3478',
  },
});

export const prisma = createPrismaClient({ databaseUrl: DATABASE_URL_TEST, maxConnections: 3 });
/** DB 14: the @app/redis tests flush DB 15 in parallel. */
export const redis = createTestRedis('api-tests', { dbIndex: 14 });

export interface FakeClock extends Clock {
  advance(ms: number): void;
}

export function createFakeClock(start = new Date('2026-10-31T12:00:00.000Z')): FakeClock {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advance: (ms) => {
      current += ms;
    },
  };
}

/** Token "fail" → rejected, "down" → Cloudflare unreachable, anything else → passes. */
export const fakeTurnstile: TurnstileVerifier = {
  verify(token) {
    if (token === 'down') return Promise.reject(new TurnstileUnavailableError('test outage'));
    return Promise.resolve(
      token === 'fail'
        ? { success: false, errorCodes: ['invalid-input-response'] }
        : { success: true, errorCodes: [] },
    );
  },
};

export function buildTestApp(overrides: Partial<AppDeps> = {}) {
  return buildApp({
    config: testConfig,
    prisma,
    redis,
    turnstile: fakeTurnstile,
    clock: createFakeClock(),
    ...overrides,
  });
}

/** A documentation-range IP, different per call, so rate limits don't leak between tests. */
export function randomTestIp(): string {
  return `198.51.100.${String(randomInt(1, 255))}`;
}

export function newDeviceId(): string {
  return randomUUID();
}
