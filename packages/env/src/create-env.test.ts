import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createEnv, EnvValidationError } from './create-env.ts';
import { applyEnvFileContent, findWorkspaceRoot } from './load-env-file.ts';
import { baseEnv, databaseEnv, redisEnv } from './schemas.ts';

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
