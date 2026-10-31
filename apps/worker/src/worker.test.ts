import { randomBytes, randomUUID } from 'node:crypto';

import { createPrismaClient } from '@app/db';
import { createEnv, databaseTestEnv, redisTestEnv } from '@app/env';
import { createLogger } from '@app/logger';
import { createTestRedis } from '@app/redis/testing';
import { BULLMQ_PREFIX, QUEUE_NAMES, type SessionLogJob } from '@app/shared/jobs';
import { Queue, QueueEvents } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { persistSessionLog } from './jobs/session-log.ts';
import { moderationDeps } from './test/moderation.ts';
import { createWorkers } from './worker.ts';

const { DATABASE_URL_TEST } = createEnv(databaseTestEnv, { service: 'worker-tests' });
const { REDIS_URL_TEST } = createEnv(redisTestEnv, { service: 'worker-tests' });
/** DB 10: other packages' tests flush 11–15 in parallel. */
const redisUrl = (() => {
  const url = new URL(REDIS_URL_TEST);
  url.pathname = '/10';
  return url.toString();
})();
const redis = createTestRedis('worker-tests', { dbIndex: 10 });
const prisma = createPrismaClient({ databaseUrl: DATABASE_URL_TEST, maxConnections: 3 });
const logger = createLogger({ service: 'worker-test', level: 'silent' });

const visitorIds: string[] = [];
const sessionIds: string[] = [];

async function newVisitor(): Promise<string> {
  const visitor = await prisma.visitor.create({
    data: { deviceIdHash: randomBytes(32).toString('hex') },
  });
  visitorIds.push(visitor.id);
  return visitor.id;
}

function job(sessionId: string, visitors: [string, string]): SessionLogJob {
  sessionIds.push(sessionId);
  return {
    sessionId,
    mode: 'video',
    topology: 'mesh',
    maxParticipants: 2,
    commonInterests: ['music'],
    startedAt: '2026-10-31T12:00:00.000Z',
    endedAt: '2026-10-31T12:05:00.000Z',
    participants: [
      {
        participantId: 'pAAAAAAAAAAA',
        visitorId: visitors[0],
        joinedAt: '2026-10-31T12:00:00.000Z',
        leftAt: '2026-10-31T12:05:00.000Z',
        leaveReason: 'SKIP',
      },
      {
        participantId: 'pBBBBBBBBBBB',
        visitorId: visitors[1],
        joinedAt: '2026-10-31T12:00:00.000Z',
        leftAt: '2026-10-31T12:05:00.000Z',
        leaveReason: null,
      },
    ],
  };
}

beforeAll(async () => {
  await redis.flushdb();
});

afterAll(async () => {
  await prisma.chatSessionLog.deleteMany({ where: { id: { in: sessionIds } } });
  await prisma.visitor.deleteMany({ where: { id: { in: visitorIds } } });
  await prisma.$disconnect();
  await redis.quit();
});

describe('session-log job', () => {
  it('persists the session and its participants idempotently', async () => {
    const sessionId = randomUUID();
    const data = job(sessionId, [await newVisitor(), await newVisitor()]);
    expect(await persistSessionLog(prisma, data, logger)).toMatchObject({
      participants: 2,
      skipped: 0,
    });
    await persistSessionLog(prisma, data, logger); // retry / duplicate delivery

    const row = await prisma.chatSessionLog.findUniqueOrThrow({
      where: { id: sessionId },
      include: { participants: { orderBy: { participantId: 'asc' } } },
    });
    expect(row).toMatchObject({ mode: 'VIDEO', topology: 'MESH', commonInterests: ['music'] });
    expect(row.participants.map((p) => [p.participantId, p.leaveReason])).toEqual([
      ['pAAAAAAAAAAA', 'SKIP'],
      ['pBBBBBBBBBBB', null],
    ]);
  });

  it('skips participants whose visitor does not exist instead of failing', async () => {
    const sessionId = randomUUID();
    const result = await persistSessionLog(
      prisma,
      job(sessionId, [await newVisitor(), randomUUID()]),
      logger,
    );
    expect(result).toMatchObject({ participants: 1, skipped: 1 });
  });

  it('is consumed from the BullMQ queue end to end', async () => {
    const workers = createWorkers({
      redisUrl,
      prisma,
      logger,
      concurrency: 2,
      moderation: moderationDeps(),
      frameBudgetPerSec: 50,
      budgetIntervalMs: 0,
    });
    const queue = new Queue<SessionLogJob>(QUEUE_NAMES.SESSION_LOG, {
      connection: { url: redisUrl },
      prefix: BULLMQ_PREFIX,
    });
    const events = new QueueEvents(QUEUE_NAMES.SESSION_LOG, {
      connection: { url: redisUrl },
      prefix: BULLMQ_PREFIX,
    });
    try {
      await events.waitUntilReady();
      const sessionId = randomUUID();
      const added = await queue.add(
        QUEUE_NAMES.SESSION_LOG,
        job(sessionId, [await newVisitor(), await newVisitor()]),
        { jobId: sessionId },
      );
      await added.waitUntilFinished(events, 10_000);
      expect(await prisma.sessionParticipant.count({ where: { sessionId } })).toBe(2);
    } finally {
      await Promise.all([workers.close(), queue.close(), events.close()]);
    }
  });
});
