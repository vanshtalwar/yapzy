import { createEnv, redisTestEnv } from '@app/env';

import { createRedis, type Redis } from './client.ts';

/**
 * Connection to the integration-test Redis DB (REDIS_URL_TEST). Refuses DB 0 because tests
 * call FLUSHDB and must never wipe development data.
 */
export function createTestRedis(connectionName: string): Redis {
  const { REDIS_URL_TEST } = createEnv(redisTestEnv, { service: 'redis-tests' });
  const db = Number(new URL(REDIS_URL_TEST).pathname.slice(1) || '0');
  if (db === 0) throw new Error('REDIS_URL_TEST must select a non-zero DB index, e.g. /15');
  return createRedis(REDIS_URL_TEST, { connectionName });
}
