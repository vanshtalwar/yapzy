import { randomBytes, randomUUID } from 'node:crypto';

import { createPrismaClient, type PrismaClient } from '@app/db';
import { createEnv, databaseTestEnv } from '@app/env';
import { banIpKey, banVisitorKey } from '@app/redis';
import { createTestRedis } from '@app/redis/testing';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createBanChecker } from './bans.ts';

const { DATABASE_URL_TEST } = createEnv(databaseTestEnv, { service: 'moderation-tests' });
const prisma = createPrismaClient({ databaseUrl: DATABASE_URL_TEST, maxConnections: 2 });
/** DB 12: other packages' tests flush 13–15 in parallel. */
const redis = createTestRedis('moderation-tests', { dbIndex: 12 });
const logger = { warn: () => undefined };
const NOW = new Date('2026-10-31T12:00:00.000Z');

const visitorIds: string[] = [];
const hash = () => randomBytes(32).toString('hex');

async function newVisitor(): Promise<string> {
  const visitor = await prisma.visitor.create({ data: { deviceIdHash: hash() } });
  visitorIds.push(visitor.id);
  return visitor.id;
}

const checker = createBanChecker({ prisma, redis, logger, now: () => NOW });

beforeEach(async () => {
  await redis.flushdb();
});

afterAll(async () => {
  await prisma.ban.deleteMany({ where: { visitorId: { in: visitorIds } } });
  await prisma.visitor.deleteMany({ where: { id: { in: visitorIds } } });
  await prisma.$disconnect();
  await redis.quit();
});

describe('ban checker', () => {
  it('returns null and caches "not banned" for every identifier it was given', async () => {
    const visitorId = await newVisitor();
    const ipHash = hash();
    expect(await checker.findActiveBan({ visitorId, ipHash })).toBeNull();
    expect(JSON.parse((await redis.get(banVisitorKey(visitorId))) ?? 'null')).toEqual({
      banned: false,
    });
    expect(await redis.exists(banIpKey(ipHash))).toBe(1);
  });

  it('prefers HARD over SHADOW and permanent over expiring, ignoring expired/revoked bans', async () => {
    const visitorId = await newVisitor();
    await prisma.ban.createMany({
      data: [
        { visitorId, type: 'SHADOW', reason: 'test' },
        {
          visitorId,
          type: 'HARD',
          reason: 'test',
          expiresAt: new Date('2026-11-05T00:00:00.000Z'),
        },
        { visitorId, type: 'HARD', reason: 'test', expiresAt: new Date('2026-10-01T00:00:00Z') },
        { visitorId, type: 'HARD', reason: 'test', revokedAt: NOW },
      ],
    });
    const ban = await checker.findActiveBan({ visitorId });
    expect(ban).toMatchObject({ type: 'HARD', expiresAt: '2026-11-05T00:00:00.000Z' });
  });

  it('decides from cache alone when every identifier is cached', async () => {
    const visitorId = randomUUID();
    const failingPrisma = new Proxy(
      {},
      {
        get() {
          throw new Error('Postgres must not be queried');
        },
      },
    ) as PrismaClient;
    const cachedOnly = createBanChecker({ prisma: failingPrisma, redis, logger, now: () => NOW });
    await redis.set(
      banVisitorKey(visitorId),
      JSON.stringify({ banned: true, banId: 'b1', type: 'SHADOW', expiresAt: null }),
    );
    expect(await cachedOnly.findActiveBan({ visitorId })).toEqual({
      banId: 'b1',
      type: 'SHADOW',
      expiresAt: null,
    });
  });
});
