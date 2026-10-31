import { randomUUID } from 'node:crypto';

import { createPrismaClient } from '@app/db';
import { createEnv, databaseTestEnv } from '@app/env';
import {
  createBanService,
  createRiskProfiles,
  createTrustStore,
  MockImageClassifier,
  NoopHashMatcher,
} from '@app/moderation';
import { createTestRedis } from '@app/redis/testing';
import { createMemoryObjectStore } from '@app/storage';

import { type ModerationDeps } from '../moderation/deps.ts';

const { DATABASE_URL_TEST } = createEnv(databaseTestEnv, { service: 'worker-tests' });

export const testPrisma = createPrismaClient({ databaseUrl: DATABASE_URL_TEST, maxConnections: 3 });
/** DB 9: the session-log tests use DB 10 for BullMQ in parallel; others flush 11–15. */
export const testRedis = createTestRedis('worker-moderation-tests', { dbIndex: 9 });
/** Unique per run: pub/sub ignores the DB index and a dev gateway may be listening. */
export const testControlChannel = `test:gw:control:${randomUUID()}`;

const silent = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

export function moderationDeps(overrides: Partial<Omit<ModerationDeps, 'objects'>> = {}) {
  const deps = {
    prisma: testPrisma,
    redis: testRedis,
    buckets: { evidence: 'evidence', frames: 'frames' },
    classifier: new MockImageClassifier(),
    hashMatcher: new NoopHashMatcher(),
    bans: createBanService({
      prisma: testPrisma,
      redis: testRedis,
      logger: silent,
      originNodeId: 'worker-test',
      controlChannel: testControlChannel,
    }),
    trust: createTrustStore({ prisma: testPrisma, redis: testRedis }),
    risk: createRiskProfiles({ redis: testRedis }),
    config: { flagThreshold: 0.8, autoShadowScore: 0.9, reportThreshold: 3, autoBanHours: 168 },
    logger: silent,
    ...overrides,
    // In-memory store: tests inspect `objects.objects`.
    objects: createMemoryObjectStore(),
  } satisfies ModerationDeps;
  return deps;
}
