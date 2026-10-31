import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createEnv, EnvValidationError } from './create-env.ts';
import { applyEnvFileContent, findWorkspaceRoot } from './load-env-file.ts';
import {
  apiEnv,
  baseEnv,
  databaseEnv,
  gatewayEnv,
  redisEnv,
  webEnv,
  workerEnv,
} from './schemas.ts';

const serviceEnv = baseEnv.extend({
  JWT_SECRET: z.string().min(32),
  API_PORT: z.coerce.number().int().positive(),
});

describe('createEnv', () => {
  it('applies defaults for the base schema', () => {
    expect(createEnv(baseEnv, { source: {} })).toEqual({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
    });
  });

  it('returns typed, coerced values for a valid config', () => {
    const env = createEnv(serviceEnv, {
      source: { NODE_ENV: 'test', JWT_SECRET: 'x'.repeat(32), API_PORT: '4000' },
    });
    expect(env.API_PORT).toBe(4000);
    expect(env.NODE_ENV).toBe('test');
  });

  it('rejects invalid config listing every problem in one readable error', () => {
    const secret = 'too-short-secret';
    const attempt = () =>
      createEnv(serviceEnv, {
        service: 'api',
        source: { LOG_LEVEL: 'loud', JWT_SECRET: secret },
      });

    expect(attempt).toThrow(EnvValidationError);
    try {
      attempt();
    } catch (error) {
      if (!(error instanceof EnvValidationError)) throw error;
      expect(error.message).toContain('Invalid environment configuration for "api"');
      expect(error.message).toContain('API_PORT: missing (required)');
      expect(error.message).toMatch(/LOG_LEVEL: .+/);
      expect(error.message).toMatch(/JWT_SECRET: .+/);
      expect(error.issues.map((issue) => issue.variable).sort()).toEqual([
        'API_PORT',
        'JWT_SECRET',
        'LOG_LEVEL',
      ]);
      // Secrets must never leak into error output.
      expect(error.message).not.toContain(secret);
    }
  });
});

describe('applyEnvFileContent', () => {
  it('fills unset keys but never overrides existing environment values', () => {
    const target: Record<string, string | undefined> = { LOG_LEVEL: 'warn' };
    applyEnvFileContent('LOG_LEVEL=debug\nNODE_ENV=test\n# comment\nQUOTED="a b"\n', target);
    expect(target).toEqual({ LOG_LEVEL: 'warn', NODE_ENV: 'test', QUOTED: 'a b' });
  });
});

describe('findWorkspaceRoot', () => {
  it('walks up to the directory containing pnpm-workspace.yaml', () => {
    const root = mkdtempSync(join(tmpdir(), 'env-root-'));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
    const nested = join(root, 'apps', 'api', 'src');
    mkdirSync(nested, { recursive: true });
    expect(findWorkspaceRoot(nested)).toBe(root);
  });
});

describe('service schemas', () => {
  it('accepts postgres and redis URLs', () => {
    expect(
      createEnv(databaseEnv, {
        source: { DATABASE_URL: 'postgresql://app:app@localhost:5432/app' },
      }).DATABASE_URL,
    ).toContain('postgresql://');
    expect(
      createEnv(redisEnv, { source: { REDIS_URL: 'redis://localhost:6379/15' } }).REDIS_URL,
    ).toBe('redis://localhost:6379/15');
  });

  it('rejects URLs with the wrong scheme', () => {
    expect(() =>
      createEnv(databaseEnv, { source: { DATABASE_URL: 'mysql://localhost/app' } }),
    ).toThrow(/DATABASE_URL: must be a postgresql:\/\/ URL/);
    expect(() => createEnv(redisEnv, { source: { REDIS_URL: 'http://localhost' } })).toThrow(
      /REDIS_URL/,
    );
  });
});

describe('apiEnv', () => {
  const valid = {
    DATABASE_URL: 'postgresql://app:app@localhost:5432/app',
    REDIS_URL: 'redis://localhost:6379',
    IP_HASH_PEPPER: 'p'.repeat(16),
    DEVICE_HASH_PEPPER: 'd'.repeat(16),
    CORS_ORIGINS: 'http://localhost:3000, http://localhost:3001',
    JWT_SECRET: 's'.repeat(32),
    TOS_VERSION: '2026-10-dev',
    TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
    TURN_SECRET: 't'.repeat(16),
    TURN_HOST: 'localhost',
    STUN_URLS: 'stun:localhost:3478',
    S3_ACCESS_KEY: 'randomchat',
    S3_SECRET_KEY: 'minio-secret',
  };

  it('parses lists, booleans and defaults', () => {
    const env = createEnv(apiEnv, { source: { ...valid, RATE_LIMIT_DISABLED: 'true' } });
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:3000', 'http://localhost:3001']);
    expect(env.STUN_URLS).toEqual(['stun:localhost:3478']);
    expect(env.RATE_LIMIT_DISABLED).toBe(true);
    expect(env.TRUST_PROXY).toBe(false);
    expect(env.API_PORT).toBe(4000);
    expect(env.JWT_TTL_SECONDS).toBe(43_200);
  });

  it('accepts hop counts and proxy lists for TRUST_PROXY but refuses "true"', () => {
    expect(createEnv(apiEnv, { source: { ...valid, TRUST_PROXY: '1' } }).TRUST_PROXY).toBe(1);
    expect(
      createEnv(apiEnv, { source: { ...valid, TRUST_PROXY: '10.0.0.0/8, 127.0.0.1' } }).TRUST_PROXY,
    ).toEqual(['10.0.0.0/8', '127.0.0.1']);
    expect(() => createEnv(apiEnv, { source: { ...valid, TRUST_PROXY: 'true' } })).toThrow(
      /TRUST_PROXY/,
    );
  });

  it('treats RATE_LIMIT_DISABLED=false as false (not truthy string)', () => {
    expect(
      createEnv(apiEnv, { source: { ...valid, RATE_LIMIT_DISABLED: 'false' } }).RATE_LIMIT_DISABLED,
    ).toBe(false);
  });
});

describe('gatewayEnv', () => {
  const valid = {
    DATABASE_URL: 'postgresql://app:app@localhost:5432/app',
    REDIS_URL: 'redis://localhost:6379',
    IP_HASH_PEPPER: 'p'.repeat(16),
    JWT_SECRET: 's'.repeat(32),
    CORS_ORIGINS: 'http://localhost:3000',
  };

  it('parses bucket overrides and applies resilience defaults', () => {
    const env = createEnv(gatewayEnv, {
      source: { ...valid, MM_BUCKETS_BY_QUEUE: '{"video:en": 32, "text:de": 1}' },
    });
    expect(env.MM_BUCKETS_BY_QUEUE).toEqual({ 'video:en': 32, 'text:de': 1 });
    expect(env.MM_BUCKETS).toBe(4);
    expect(env.RECONNECT_GRACE_MS).toBe(15_000);
    expect(env.MATCH_ACK_TIMEOUT_MS).toBe(5_000);
    expect(env.MM_REGION).toBe('local');
    expect(createEnv(gatewayEnv, { source: valid }).MM_BUCKETS_BY_QUEUE).toEqual({});
  });

  it('parses moderation sampling settings with the documented defaults', () => {
    const env = createEnv(gatewayEnv, { source: valid });
    expect(env.MOD_FRAME_INTERVALS_MS).toEqual({
      high: 20_000,
      new: 30_000,
      normal: 120_000,
      trusted: 0,
    });
    expect(env).toMatchObject({
      MOD_NORMAL_SAMPLE_RATE: 0.3,
      MOD_TRUSTED_SPOTCHECK_RATE: 0.1,
      MOD_FRAME_BUDGET_PER_SEC: 50,
      TRUST_SHADOW_BELOW: 10,
      TRUST_HIGH_RISK_BELOW: 40,
      TRUST_TRUSTED_FROM: 70,
    });
    for (const bad of ['{nope', '{"high": 1000, "new": 30000, "normal": 120000, "trusted": 0}']) {
      expect(() =>
        createEnv(gatewayEnv, { source: { ...valid, MOD_FRAME_INTERVALS_MS: bad } }),
      ).toThrow(/MOD_FRAME_INTERVALS_MS/);
    }
    expect(() =>
      createEnv(gatewayEnv, { source: { ...valid, MOD_NORMAL_SAMPLE_RATE: '1.5' } }),
    ).toThrow(/MOD_NORMAL_SAMPLE_RATE/);
  });

  it('rejects malformed bucket overrides', () => {
    for (const bad of ['{not json', '{"en": 4}', '{"video:en": 0}']) {
      expect(() =>
        createEnv(gatewayEnv, { source: { ...valid, MM_BUCKETS_BY_QUEUE: bad } }),
      ).toThrow(/MM_BUCKETS_BY_QUEUE/);
    }
  });
});

describe('workerEnv', () => {
  it('reads S3, thresholds and the dev force-flag list', () => {
    const env = createEnv(workerEnv, {
      source: {
        DATABASE_URL: 'postgresql://app:app@localhost:5432/app',
        REDIS_URL: 'redis://localhost:6379',
        S3_ACCESS_KEY: 'randomchat',
        S3_SECRET_KEY: 'minio-secret',
        DEV_FORCE_FLAG_VISITOR_IDS: ' a1, b2 ,',
      },
    });
    expect(env).toMatchObject({
      S3_ENDPOINT: 'http://localhost:9000',
      S3_BUCKET_EVIDENCE: 'evidence',
      S3_BUCKET_FRAMES: 'frames',
      MOD_AUTO_SHADOW_SCORE: 0.9,
      MOD_REPORT_THRESHOLD: 3,
      MOD_AUTO_BAN_HOURS: 168,
      DEV_FORCE_FLAG_VISITOR_IDS: ['a1', 'b2'],
    });
  });
});

describe('webEnv', () => {
  it('defaults to local development URLs and the Turnstile test key', () => {
    expect(createEnv(webEnv, { source: {} })).toMatchObject({
      NEXT_PUBLIC_API_URL: 'http://localhost:4000',
      NEXT_PUBLIC_GATEWAY_URL: 'http://localhost:4001',
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
    });
  });
});
