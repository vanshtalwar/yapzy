import { type Logger } from '@app/logger';
import { Redis, type RedisOptions } from 'ioredis';

export interface CreateRedisOptions {
  /** Shown in `CLIENT LIST`, e.g. "gateway:sub". */
  connectionName?: string;
  /** Don't connect until the first command (or an explicit `connect()`). */
  lazyConnect?: boolean;
  /** Connection errors are logged here; without it ioredis prints to stderr. */
  logger?: Pick<Logger, 'error'>;
  /** Raw ioredis overrides, e.g. `{ maxRetriesPerRequest: null }` for BullMQ workers. */
  redisOptions?: RedisOptions;
}

/** Exponential backoff (100 ms → 2 s cap) with jitter so restarted nodes don't reconnect in lockstep. */
export function redisRetryDelayMs(attempt: number): number {
  const ceiling = Math.min(2_000, 100 * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
}

export function createRedis(url: string, options: CreateRedisOptions = {}): Redis {
  const client = new Redis(url, {
    // ioredis 6 defaults to RESP3; RESP2 keeps reply shapes stable for Lua scripts and the
    // Socket.io adapter (CONTEXT.md D-019).
    protocol: 2,
    lazyConnect: options.lazyConnect ?? false,
    maxRetriesPerRequest: 3,
    retryStrategy: redisRetryDelayMs,
    // Reconnect after a failover demoted our node to a replica.
    reconnectOnError: (error) => error.message.startsWith('READONLY'),
    ...(options.connectionName === undefined ? {} : { connectionName: options.connectionName }),
    ...options.redisOptions,
  });

  const { logger } = options;
  if (logger !== undefined) {
    client.on('error', (error: Error) => {
      logger.error({ err: error, connection: options.connectionName }, 'redis connection error');
    });
  }
  return client;
}

export type { Redis, RedisOptions } from 'ioredis';
