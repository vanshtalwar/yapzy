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

const port = z.coerce.number().int().min(1).max(65_535);

const commaList = z.string().transform((value) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0),
);

/**
 * `TRUST_PROXY`: empty/"false" = don't trust X-Forwarded-For (dev default); a number = trust
 * that many hops; otherwise a comma list of proxy IPs/CIDRs. `true` (trust everyone) is
 * deliberately not supported: any client could then spoof its IP and dodge IP rate limits/bans.
 */
const trustProxy = z
  .string()
  .default('')
  .transform((value, context): false | number | string[] => {
    const trimmed = value.trim();
    if (trimmed === '' || trimmed === 'false') return false;
    if (/^\d+$/.test(trimmed)) return Number(trimmed);
    if (trimmed === 'true') {
      context.addIssue({ code: 'custom', message: 'use a hop count or proxy IP/CIDR list' });
      return z.NEVER;
    }
    return trimmed.split(',').map((item) => item.trim());
  });

export const apiEnv = baseEnv.extend({
  ...hashPepperEnv.shape,
  DATABASE_URL: postgresUrl,
  REDIS_URL: redisUrl,
  API_HOST: z.string().min(1).default('0.0.0.0'),
  API_PORT: port.default(4000),
  CORS_ORIGINS: commaList.pipe(z.array(z.url()).min(1)),
  TRUST_PROXY: trustProxy,
  RATE_LIMIT_DISABLED: z.stringbool().default(false),
  JWT_SECRET: z.string().min(32),
  JWT_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(7 * 24 * 60 * 60)
    .default(43_200),
  TOS_VERSION: z.string().min(1).max(32),
  TURNSTILE_SECRET_KEY: z.string().min(1),
  TURN_SECRET: z.string().min(16),
  TURN_HOST: z.string().min(1),
  TURN_PORT: port.default(3478),
  TURN_CREDENTIAL_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(600),
  STUN_URLS: commaList.pipe(z.array(z.string().regex(/^stuns?:/, 'must start with stun:')).min(1)),
});

export type ApiEnv = z.output<typeof apiEnv>;

export const gatewayEnv = baseEnv.extend({
  DATABASE_URL: postgresUrl,
  REDIS_URL: redisUrl,
  IP_HASH_PEPPER: hashPepperEnv.shape.IP_HASH_PEPPER,
  JWT_SECRET: z.string().min(32),
  GATEWAY_HOST: z.string().min(1).default('0.0.0.0'),
  GATEWAY_PORT: port.default(4001),
  /** Unique per process; defaults to "<hostname>-<port>" (see apps/gateway). */
  GATEWAY_NODE_ID: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .optional(),
  CORS_ORIGINS: commaList.pipe(z.array(z.url()).min(1)),
  TRUST_PROXY: trustProxy,
  RATE_LIMIT_DISABLED: z.stringbool().default(false),
  /** How long an interest ticket waits for a shared interest before joining the general queue. */
  INTEREST_FALLBACK_MS: z.coerce.number().int().min(0).max(60_000).default(5_000),
  /** A matched pair won't be matched with each other again for this long. */
  RECENT_PAIR_TTL_MS: z.coerce.number().int().min(0).max(3_600_000).default(60_000),
  // --- Session resilience (D-046…D-048) ---
  /** A disconnected participant can `session:resume` this long before leaving for good. */
  RECONNECT_GRACE_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
  /** Participants must `match:ack` this soon after `match:found`. */
  MATCH_ACK_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(5_000),
  /** Sessions failing this soon after the match requeue the innocent side with priority. */
  EARLY_FAILURE_WINDOW_MS: z.coerce.number().int().min(0).max(120_000).default(10_000),
  // --- Queue buckets & hot-key sharding (D-052, D-053) ---
  MM_REGION: z
    .string()
    .regex(/^[a-z0-9-]{1,32}$/)
    .default('local'),
  MM_BUCKETS: z.coerce.number().int().min(1).max(1_024).default(4),
  /** JSON overrides per `<mode>:<lang>`, e.g. {"video:en": 32}. */
  MM_BUCKETS_BY_QUEUE: z
    .string()
    .default('')
    .transform((value, context) => {
      if (value.trim() === '') return {};
      try {
        return JSON.parse(value) as unknown;
      } catch {
        context.addIssue({ code: 'custom', message: 'must be JSON, e.g. {"video:en": 32}' });
        return z.NEVER;
      }
    })
    .pipe(
      z.record(
        z.string().regex(/^(text|video):[a-z]{2}$/, 'keys look like "video:en"'),
        z.number().int().min(1).max(1_024),
      ),
    ),
  MM_BUCKET_HOP_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
  DEADLINE_SHARDS: z.coerce.number().int().min(1).max(1_024).default(16),
  STATS_COUNTER_SHARDS: z.coerce.number().int().min(1).max(1_024).default(16),
});

export type GatewayEnv = z.output<typeof gatewayEnv>;

export const workerEnv = baseEnv.extend({
  DATABASE_URL: postgresUrl,
  REDIS_URL: redisUrl,
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(10),
});

export type WorkerEnv = z.output<typeof workerEnv>;
