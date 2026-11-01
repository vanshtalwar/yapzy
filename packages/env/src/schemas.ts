import { z } from 'zod';

export const NODE_ENVS = ['development', 'test', 'production'] as const;
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export const DEPLOY_ENVS = ['development', 'staging', 'production'] as const;

/** Variables every service reads. Service schemas extend this via `baseEnv.extend({...})`. */
export const baseEnv = z.object({
  NODE_ENV: z.enum(NODE_ENVS).default('development'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  /**
   * Where this build runs. NODE_ENV says how code is built (`next build` is always
   * `production`); DEPLOY_ENV says whether real users are served: `production` turns on
   * deployment guards (no Turnstile test keys, hostname check, protected /metrics).
   */
  DEPLOY_ENV: z.enum(DEPLOY_ENVS).default('development'),
});

export type BaseEnv = z.output<typeof baseEnv>;
export type NodeEnv = BaseEnv['NODE_ENV'];
export type LogLevel = BaseEnv['LOG_LEVEL'];
export type DeployEnv = BaseEnv['DEPLOY_ENV'];

/** Cloudflare's documented Turnstile testing site keys and secrets (`1x000…AA`, `3x000…FF`). */
export const TURNSTILE_TEST_KEY = /^[0-9]x0+[A-F]{2}$/i;

/** Values from .env.example that must never reach a real deployment. */
const PLACEHOLDER_SECRET = /dev-only|change-me|placeholder|^0+$/i;

/**
 * DEPLOY_ENV=production: NODE_ENV must be production too (secure cookies, no dev toggles such
 * as RATE_LIMIT_DISABLED) and the listed secrets must not be the .env.example placeholders.
 */
function productionGuards<T extends { NODE_ENV: string; DEPLOY_ENV: string }>(
  secrets: readonly (keyof T & string)[],
) {
  return (env: T, context: z.RefinementCtx): void => {
    if (env.DEPLOY_ENV !== 'production') return;
    if (env.NODE_ENV !== 'production') {
      context.addIssue({
        code: 'custom',
        path: ['NODE_ENV'],
        message: 'must be production when DEPLOY_ENV=production',
      });
    }
    for (const key of secrets) {
      const value = env[key];
      if (typeof value === 'string' && PLACEHOLDER_SECRET.test(value)) {
        context.addIssue({
          code: 'custom',
          path: [key],
          message: 'development placeholder refused when DEPLOY_ENV=production',
        });
      }
    }
  };
}

/** `/metrics` on api, gateway and worker: optional bearer token (required in production). */
export const metricsEnv = z.object({
  METRICS_TOKEN: z.string().min(16).optional(),
});

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

/** S3-compatible object storage (MinIO in development): report evidence and sampled frames. */
export const s3Env = baseEnv.extend({
  S3_ENDPOINT: z.url().default('http://localhost:9000'),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(8),
  S3_BUCKET_EVIDENCE: z.string().min(3).default('evidence'),
  S3_BUCKET_FRAMES: z.string().min(3).default('frames'),
  /** Host used in presigned URLs given to browsers (admin evidence); defaults to S3_ENDPOINT. */
  S3_PUBLIC_ENDPOINT: z.url().optional(),
});
export type S3Env = z.output<typeof s3Env>;

const rate = z.coerce.number().min(0).max(1);

/** Trust-score thresholds (0–100) shared by the gateway (pool, sampling) and the worker. */
export const trustEnv = z.object({
  /** Below this, a visitor is matched only within the shadow pool. */
  TRUST_SHADOW_BELOW: z.coerce.number().int().min(0).max(100).default(10),
  /** Below this, video is sampled at the `high` risk tier. */
  TRUST_HIGH_RISK_BELOW: z.coerce.number().int().min(0).max(100).default(40),
  /** From this (and no recent reports), video is only spot-checked (`trusted` tier). */
  TRUST_TRUSTED_FROM: z.coerce.number().int().min(0).max(100).default(70),
});

/** Global cap on frames per second sent for server-side checks (D-054). */
const frameBudget = z.coerce.number().min(1).max(100_000).default(50);

const commaList = z.string().transform((value) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0),
);

const wsUrl = z.url({ protocol: /^wss?$/, error: 'must be a ws:// or wss:// URL' });

/**
 * `JANUS_NODES`: JSON list of Janus nodes `{ id, wsUrl, adminUrl }` (Part 11). `wsUrl` is
 * handed to browsers; `adminUrl` (Admin API) is for the gateway only. Empty = no SFU.
 */
const janusNodes = z
  .string()
  .default('[]')
  .transform((value, context) => {
    if (value.trim() === '') return [];
    try {
      return JSON.parse(value) as unknown;
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'must be JSON, e.g. [{"id":"janus-1","wsUrl":"ws://…","adminUrl":"ws://…"}]',
      });
      return z.NEVER;
    }
  })
  .pipe(
    z
      .array(
        z.object({
          id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
          wsUrl,
          adminUrl: wsUrl,
        }),
      )
      .max(64)
      .refine((nodes) => new Set(nodes.map((node) => node.id)).size === nodes.length, {
        message: 'node ids must be unique',
      }),
  );

/** Janus secrets end up in its config files: letters, digits, "-" and "_" only. */
const janusSecret = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/, '16-128 of A-Z a-z 0-9 _ -');

/** SFU + group calls (Parts 11–12). Secrets are required once JANUS_NODES lists a node. */
export const sfuEnv = z.object({
  JANUS_NODES: janusNodes,
  JANUS_ADMIN_SECRET: janusSecret.optional(),
  JANUS_TOKEN_SECRET: janusSecret.optional(),
  /** Max video bitrate per publisher in a Janus room (bps). */
  SFU_PUBLISHER_BITRATE: z.coerce.number().int().min(64_000).max(10_000_000).default(600_000),
  /** Every participant must confirm a mesh → SFU switch within this long, else it rolls back. */
  SFU_UPGRADE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(10_000),
  /** Development only: every video call starts on Janus. */
  DEV_FORCE_SFU: z.stringbool().default(false),
  /** Every participant of a group call, and every joiner, needs at least this trust score. */
  GROUP_MIN_TRUST: z.coerce.number().int().min(0).max(100).default(60),
  /** A call looking for one more person gives up after this long. */
  SEEK_PARTICIPANT_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(600_000).default(30_000),
});

/** Integration tests against the dev Janus container (packages/sfu). */
export const janusTestEnv = baseEnv.extend({
  JANUS_NODES: janusNodes,
  JANUS_ADMIN_SECRET: janusSecret,
  JANUS_TOKEN_SECRET: janusSecret,
});

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

export const apiEnv = baseEnv
  .extend({
    ...hashPepperEnv.shape,
    DATABASE_URL: postgresUrl,
    REDIS_URL: redisUrl,
    API_HOST: z.string().min(1).default('0.0.0.0'),
    API_PORT: port.default(4000),
    CORS_ORIGINS: commaList.pipe(z.array(z.url()).min(1)),
    /**
     * Origins of the admin dashboard: the only ones allowed to call `/v1/admin/*` with
     * credentials (cookie) and the CSRF header. Never list the public site here.
     */
    ADMIN_ORIGINS: z
      .string()
      .default('http://localhost:3001')
      .pipe(commaList)
      .pipe(z.array(z.url()).min(1)),
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
    /** Hostnames a Turnstile token may come from (siteverify `hostname`); empty = not checked. */
    TURNSTILE_HOSTNAMES: commaList.default([]),
    TURN_SECRET: z.string().min(16),
    TURN_HOST: z.string().min(1),
    TURN_PORT: port.default(3478),
    /** Optional TURN-over-TLS port (production: 443) → an extra `turns:` URL for clients. */
    TURN_TLS_PORT: port.optional(),
    TURN_CREDENTIAL_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(600),
    STUN_URLS: commaList.pipe(
      z.array(z.string().regex(/^stuns?:/, 'must start with stun:')).min(1),
    ),
    ...s3Env.shape,
    STATS_COUNTER_SHARDS: z.coerce.number().int().min(1).max(1_024).default(16),
    // --- Admin (Part 9) ---
    /** AES-256-GCM key (64 hex chars) encrypting admin TOTP secrets at rest. */
    ADMIN_TOTP_ENC_KEY: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex characters (32 bytes)'),
    ADMIN_SESSION_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(300)
      .max(7 * 24 * 3_600)
      .default(28_800),
    ...metricsEnv.shape,
  })
  .superRefine((env, context) => {
    productionGuards<typeof env>([
      'JWT_SECRET',
      'IP_HASH_PEPPER',
      'DEVICE_HASH_PEPPER',
      'TURN_SECRET',
      'S3_SECRET_KEY',
      'ADMIN_TOTP_ENC_KEY',
    ])(env, context);
    if (env.DEPLOY_ENV !== 'production') return;
    if (TURNSTILE_TEST_KEY.test(env.TURNSTILE_SECRET_KEY)) {
      context.addIssue({
        code: 'custom',
        path: ['TURNSTILE_SECRET_KEY'],
        message: 'Cloudflare test secrets are refused when DEPLOY_ENV=production',
      });
    }
    if (env.TURNSTILE_HOSTNAMES.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['TURNSTILE_HOSTNAMES'],
        message: 'required when DEPLOY_ENV=production (the site hostnames tokens must come from)',
      });
    }
  });

export type ApiEnv = z.output<typeof apiEnv>;

export const gatewayEnv = baseEnv
  .extend({
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
    // --- Trust & safety (Part 8, D-054) ---
    ...trustEnv.shape,
    /** Frame-sampling interval per risk tier; `trusted: 0` = only spot checks. */
    MOD_FRAME_INTERVALS_MS: z
      .string()
      .default('{"high": 20000, "new": 30000, "normal": 120000, "trusted": 0}')
      .transform((value, context) => {
        try {
          return JSON.parse(value) as unknown;
        } catch {
          context.addIssue({ code: 'custom', message: 'must be JSON, e.g. {"high": 20000, ...}' });
          return z.NEVER;
        }
      })
      .pipe(
        z.object({
          high: z.number().int().min(5_000),
          new: z.number().int().min(5_000),
          normal: z.number().int().min(5_000),
          trusted: z.number().int().min(0),
        }),
      ),
    /** Share of `normal`-tier participants whose video is sampled at all. */
    MOD_NORMAL_SAMPLE_RATE: rate.default(0.3),
    /** Share of `trusted`-tier participants that get one spot-check frame. */
    MOD_TRUSTED_SPOTCHECK_RATE: rate.default(0.1),
    MOD_FRAME_BUDGET_PER_SEC: frameBudget,
    ...metricsEnv.shape,
    /**
     * Socket handshakes per minute (fixed window, Redis): per visitor, and per client IP hash
     * (generous: carrier-grade NAT puts many people behind one IPv4 address).
     */
    HANDSHAKE_LIMIT_PER_VISITOR: z.coerce.number().int().min(1).max(1_000_000).default(30),
    HANDSHAKE_LIMIT_PER_IP: z.coerce.number().int().min(1).max(10_000_000).default(600),
    // --- SFU + group calls (Parts 11–12) ---
    ...sfuEnv.shape,
  })
  .superRefine((env, context) => {
    productionGuards<typeof env>([
      'JWT_SECRET',
      'IP_HASH_PEPPER',
      'JANUS_ADMIN_SECRET',
      'JANUS_TOKEN_SECRET',
    ])(env, context);
    if (env.JANUS_NODES.length === 0) return;
    for (const key of ['JANUS_ADMIN_SECRET', 'JANUS_TOKEN_SECRET'] as const) {
      if (env[key] === undefined) {
        context.addIssue({
          code: 'custom',
          path: [key],
          message: 'required when JANUS_NODES lists a node',
        });
      }
    }
  });

export type GatewayEnv = z.output<typeof gatewayEnv>;

export const workerEnv = baseEnv
  .extend({
    DATABASE_URL: postgresUrl,
    REDIS_URL: redisUrl,
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(10),
    /** Small HTTP server for /health and /metrics (the worker has no other HTTP surface). */
    WORKER_METRICS_HOST: z.string().min(1).default('0.0.0.0'),
    WORKER_METRICS_PORT: port.default(4002),
    ...metricsEnv.shape,
    ...s3Env.shape,
    ...trustEnv.shape,
    MOD_FRAME_BUDGET_PER_SEC: frameBudget,
    /** Classifier score from which an automatic flag also shadow-bans the visitor. */
    MOD_AUTO_SHADOW_SCORE: rate.default(0.9),
    /** Distinct reporters within 24 h that shadow-ban a visitor automatically. */
    MOD_REPORT_THRESHOLD: z.coerce.number().int().min(1).max(100).default(3),
    /** Length of automatic shadow bans. */
    MOD_AUTO_BAN_HOURS: z.coerce.number().int().min(1).max(8_760).default(168),
    /**
     * Development only: the mock image classifier flags every frame of these visitors (comma
     * list of visitor ids) so the moderation pipeline can be exercised without real content.
     */
    DEV_FORCE_FLAG_VISITOR_IDS: commaList.default([]),
  })
  .superRefine((env, context) => {
    productionGuards<typeof env>(['S3_SECRET_KEY'])(env, context);
  });

export type WorkerEnv = z.output<typeof workerEnv>;

/**
 * Public (browser) configuration of apps/web, inlined by Next.js at build time. Defaults suit
 * local development (Cloudflare's always-pass Turnstile test key); a build with
 * DEPLOY_ENV=production refuses test keys (NODE_ENV can't tell: `next build` always runs with
 * NODE_ENV=production).
 */
export const webEnv = baseEnv
  .extend({
    NEXT_PUBLIC_API_URL: z.url().default('http://localhost:4000'),
    NEXT_PUBLIC_GATEWAY_URL: z.url().default('http://localhost:4001'),
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: z.string().min(1).default('1x00000000000000000000AA'),
    /** Relay-only ICE for video (verify TURN, or hide IPs from peers at a bandwidth cost). */
    NEXT_PUBLIC_FORCE_TURN_RELAY: z.stringbool().default(false),
    /** Janus nodes (Part 11): their browser-facing `wsUrl`s go into the CSP's connect-src. */
    JANUS_NODES: janusNodes,
  })
  .superRefine((env, context) => {
    if (
      env.DEPLOY_ENV === 'production' &&
      TURNSTILE_TEST_KEY.test(env.NEXT_PUBLIC_TURNSTILE_SITE_KEY)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['NEXT_PUBLIC_TURNSTILE_SITE_KEY'],
        message: 'Cloudflare test site keys are refused when DEPLOY_ENV=production',
      });
    }
  });

/** apps/admin (Next.js): its API and the origin of presigned evidence URLs (CSP img-src). */
export const adminWebEnv = baseEnv.extend({
  NEXT_PUBLIC_API_URL: z.url().default('http://localhost:4000'),
  S3_PUBLIC_ENDPOINT: z.url().optional(),
  S3_ENDPOINT: z.url().default('http://localhost:9000'),
});
export type AdminWebEnv = z.output<typeof adminWebEnv>;

export type WebEnv = z.output<typeof webEnv>;
