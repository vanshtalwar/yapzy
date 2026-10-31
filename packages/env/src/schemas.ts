import { z } from 'zod';

export const NODE_ENVS = ['development', 'test', 'production'] as const;
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/** Variables every service reads. Service schemas extend this via `baseEnv.extend({...})`. */
export const baseEnv = z.object({
  NODE_ENV: z.enum(NODE_ENVS).default('development'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
});

export type BaseEnv = z.output<typeof baseEnv>;
export type NodeEnv = BaseEnv['NODE_ENV'];
export type LogLevel = BaseEnv['LOG_LEVEL'];

const postgresUrl = z.url({
  protocol: /^postgres(ql)?$/,
  error: 'must be a postgresql:// URL',
});
const redisUrl = z.url({ protocol: /^rediss?$/, error: 'must be a redis:// or rediss:// URL' });

export const databaseEnv = baseEnv.extend({ DATABASE_URL: postgresUrl });
export const databaseTestEnv = baseEnv.extend({ DATABASE_URL_TEST: postgresUrl });

export const redisEnv = baseEnv.extend({ REDIS_URL: redisUrl });
export const redisTestEnv = baseEnv.extend({ REDIS_URL_TEST: redisUrl });

/** Peppers for HMAC-hashing raw IPs and device IDs; rotating one invalidates existing hashes. */
export const hashPepperEnv = z.object({
  IP_HASH_PEPPER: z.string().min(16),
  DEVICE_HASH_PEPPER: z.string().min(16),
});

export const seedEnv = databaseEnv.extend({
  ...hashPepperEnv.shape,
  SEED_ADMIN_EMAIL: z.email(),
  SEED_ADMIN_PASSWORD: z.string().min(12),
});

export type DatabaseEnv = z.output<typeof databaseEnv>;
export type RedisEnv = z.output<typeof redisEnv>;
export type SeedEnv = z.output<typeof seedEnv>;
