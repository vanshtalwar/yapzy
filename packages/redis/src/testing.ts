import { createEnv, redisTestEnv } from '@app/env';

import { createRedis, type Redis } from './client.ts';

/**
 * Connection to an integration-test Redis DB. Tests call FLUSHDB, so DB 0 (development data)
 * is refused. turbo runs packages' tests in parallel, so each package passes its own
 * `dbIndex` (redis: 15 from REDIS_URL_TEST, api: 14, gateway: 13) to avoid flushing another
 * package's data mid-run.
 */
export function createTestRedis(connectionName: string, options: { dbIndex?: number } = {}): Redis {
  const { REDIS_URL_TEST } = createEnv(redisTestEnv, { service: 'redis-tests' });
  const url = new URL(REDIS_URL_TEST);
  if (options.dbIndex !== undefined) url.pathname = `/${String(options.dbIndex)}`;
  const db = Number(url.pathname.slice(1) || '0');
  if (db === 0) throw new Error('Test Redis must use a non-zero DB index, e.g. /15');
  return createRedis(url.toString(), { connectionName });
}
