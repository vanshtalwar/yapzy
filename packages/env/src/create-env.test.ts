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
      DEPLOY_ENV: 'development',
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
    ADMIN_TOTP_ENC_KEY: 'ab'.repeat(32),
  };

  it('refuses Turnstile test secrets and requires hostnames when DEPLOY_ENV=production', () => {
    const production = { ...valid, DEPLOY_ENV: 'production', NODE_ENV: 'production' };
    expect(() => createEnv(apiEnv, { source: production })).toThrow(/TURNSTILE_SECRET_KEY/);
    expect(() =>
      createEnv(apiEnv, {
        source: { ...production, TURNSTILE_SECRET_KEY: '0x4AAAAAAAreal-secret' },
      }),
    ).toThrow(/TURNSTILE_HOSTNAMES/);
    const env = createEnv(apiEnv, {
      source: {
        ...production,
        TURNSTILE_SECRET_KEY: '0x4AAAAAAAreal-secret',
        TURNSTILE_HOSTNAMES: 'randomchat.example, www.randomchat.example',
        METRICS_TOKEN: 'm'.repeat(32),
      },
    });
    expect(env.TURNSTILE_HOSTNAMES).toEqual(['randomchat.example', 'www.randomchat.example']);
    expect(env.METRICS_TOKEN).toBe('m'.repeat(32));
    // Staging and development may use the test keys.
    expect(createEnv(apiEnv, { source: { ...valid, DEPLOY_ENV: 'staging' } }).DEPLOY_ENV).toBe(
      'staging',
    );
    expect(() => createEnv(apiEnv, { source: { ...valid, METRICS_TOKEN: 'short' } })).toThrow(
      /METRICS_TOKEN/,
    );
  });

  it('refuses .env.example placeholders and a non-production NODE_ENV in production', () => {
    const real = {
      ...valid,
      DEPLOY_ENV: 'production',
      NODE_ENV: 'production',
      TURNSTILE_SECRET_KEY: '0x4AAAAAAAreal-secret',
      TURNSTILE_HOSTNAMES: 'randomchat.example',
    };
    expect(createEnv(apiEnv, { source: real }).DEPLOY_ENV).toBe('production');
    expect(() => createEnv(apiEnv, { source: { ...real, NODE_ENV: 'development' } })).toThrow(
      /NODE_ENV/,
    );
    for (const [key, value] of [
      ['JWT_SECRET', 'dev-only-jwt-secret-change-me-0123456789abcdef'],
      ['IP_HASH_PEPPER', 'dev-only-ip-pepper-change-me'],
      ['ADMIN_TOTP_ENC_KEY', '0'.repeat(64)],
      ['S3_SECRET_KEY', 'dev-only-minio-secret-change-me'],
    ] as const) {
      expect(() => createEnv(apiEnv, { source: { ...real, [key]: value } })).toThrow(
        new RegExp(key),
      );
    }
    // Development keeps working with the placeholders.
    expect(
      createEnv(apiEnv, {
        source: { ...valid, JWT_SECRET: 'dev-only-jwt-secret-change-me-0123456789abcdef' },
      }).JWT_SECRET,
    ).toContain('dev-only');
  });

  it('requires a 32-byte hex key for admin TOTP secrets', () => {
    expect(() => createEnv(apiEnv, { source: { ...valid, ADMIN_TOTP_ENC_KEY: 'short' } })).toThrow(
      /ADMIN_TOTP_ENC_KEY/,
    );
    expect(createEnv(apiEnv, { source: valid }).ADMIN_SESSION_TTL_SECONDS).toBe(28_800);
  });

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

  it('reads Janus nodes; their secrets are required once a node is listed (Part 11)', () => {
    const node = { id: 'janus-1', wsUrl: 'ws://localhost:8188', adminUrl: 'ws://localhost:7188' };
    const off = createEnv(gatewayEnv, { source: valid });
    expect(off).toMatchObject({
      JANUS_NODES: [],
      SFU_PUBLISHER_BITRATE: 600_000,
      SFU_UPGRADE_TIMEOUT_MS: 10_000,
      DEV_FORCE_SFU: false,
    });
    const secrets = {
      JANUS_ADMIN_SECRET: 'admin-secret-0123456789',
      JANUS_TOKEN_SECRET: 'token-secret-0123456789',
    };
    const on = createEnv(gatewayEnv, {
      source: { ...valid, ...secrets, JANUS_NODES: JSON.stringify([node]), DEV_FORCE_SFU: 'true' },
    });
    expect(on.JANUS_NODES).toEqual([node]);
    expect(on.DEV_FORCE_SFU).toBe(true);
    expect(() =>
      createEnv(gatewayEnv, { source: { ...valid, JANUS_NODES: JSON.stringify([node]) } }),
    ).toThrow(/JANUS_ADMIN_SECRET[\s\S]*JANUS_TOKEN_SECRET/);
    for (const bad of [
      '[{nope',
      JSON.stringify([{ ...node, wsUrl: 'http://localhost:8188' }]),
      JSON.stringify([node, node]), // duplicate ids
    ]) {
      expect(() =>
        createEnv(gatewayEnv, { source: { ...valid, ...secrets, JANUS_NODES: bad } }),
      ).toThrow(/JANUS_NODES/);
    }
    // Secrets go into Janus config files: no quotes or spaces.
    expect(() =>
      createEnv(gatewayEnv, {
        source: { ...valid, ...secrets, JANUS_ADMIN_SECRET: 'has "quotes" in it!' },
      }),
    ).toThrow(/JANUS_ADMIN_SECRET/);
    expect(() =>
      createEnv(gatewayEnv, {
        source: {
          ...valid,
          JANUS_NODES: JSON.stringify([node]),
          JANUS_ADMIN_SECRET: 'dev-only-janus-admin-secret-change-me',
          JANUS_TOKEN_SECRET: 'token-secret-0123456789',
          NODE_ENV: 'production',
          DEPLOY_ENV: 'production',
          JWT_SECRET: 'x'.repeat(40),
          IP_HASH_PEPPER: 'y'.repeat(20),
        },
      }),
    ).toThrow(/JANUS_ADMIN_SECRET/);
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

  it('refuses Turnstile test site keys when DEPLOY_ENV=production', () => {
    for (const key of [
      '1x00000000000000000000AA',
      '2x00000000000000000000AB',
      '3x00000000000000000000FF',
    ]) {
      expect(() =>
        createEnv(webEnv, {
          source: { DEPLOY_ENV: 'production', NEXT_PUBLIC_TURNSTILE_SITE_KEY: key },
        }),
      ).toThrow(/NEXT_PUBLIC_TURNSTILE_SITE_KEY/);
    }
    const env = createEnv(webEnv, {
      source: {
        DEPLOY_ENV: 'production',
        NEXT_PUBLIC_TURNSTILE_SITE_KEY: '0x4AAAAAAAreal-site-key',
      },
    });
    expect(env.NEXT_PUBLIC_TURNSTILE_SITE_KEY).toBe('0x4AAAAAAAreal-site-key');
  });
});
