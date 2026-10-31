import { randomBytes, randomUUID } from 'node:crypto';

import { createPrismaClient } from '@app/db';
import { createEnv, databaseTestEnv } from '@app/env';
import {
  banDeviceKey,
  banVisitorKey,
  type GwControlMessage,
  riskProfileKey,
  subscribeControl,
  trustKey,
} from '@app/redis';
import { createTestRedis } from '@app/redis/testing';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createBanService } from './ban-service.ts';
import { createRiskProfiles, createTrustStore } from './stores.ts';

const { DATABASE_URL_TEST } = createEnv(databaseTestEnv, { service: 'moderation-tests' });
const prisma = createPrismaClient({ databaseUrl: DATABASE_URL_TEST, maxConnections: 2 });
const redis = createTestRedis('moderation-ban-service', { dbIndex: 12 });
const subscriber = createTestRedis('moderation-ban-service-sub', { dbIndex: 12 });
const channel = `test:gw:control:${randomUUID()}`;
const logger = { warn: () => undefined, info: () => undefined };

const visitorIds: string[] = [];
const hash = () => randomBytes(32).toString('hex');
async function newVisitor(trustScore = 50) {
  const visitor = await prisma.visitor.create({ data: { deviceIdHash: hash(), trustScore } });
  visitorIds.push(visitor.id);
  return visitor;
}

const bans = createBanService({
  prisma,
  redis,
  logger,
  originNodeId: 'test',
  controlChannel: channel,
});
const trust = createTrustStore({ prisma, redis });
const risk = createRiskProfiles({ redis });

beforeEach(async () => {
  await redis.flushdb();
});

afterAll(async () => {
  await prisma.ban.deleteMany({ where: { visitorId: { in: visitorIds } } });
  await prisma.visitor.deleteMany({ where: { id: { in: visitorIds } } });
  await prisma.$disconnect();
  await Promise.all([redis.quit(), subscriber.quit()]);
});

describe('BanService', () => {
  it('writes the ban, refreshes the cache and publishes ban_applied', async () => {
    const visitor = await newVisitor();
    const messages: GwControlMessage[] = [];
    const unsubscribe = await subscribeControl(
      subscriber,
      { onMessage: (m) => messages.push(m) },
      channel,
    );
    await redis.set(banVisitorKey(visitor.id), JSON.stringify({ banned: false }));

    const { banId, active } = await bans.apply({
      visitorId: visitor.id,
      type: 'SHADOW',
      reason: 'auto: classifier',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    expect(active).toMatchObject({ banId, type: 'SHADOW' });
    expect(JSON.parse((await redis.get(banVisitorKey(visitor.id))) ?? '{}')).toMatchObject({
      banned: true,
      banId,
      type: 'SHADOW',
    });
    await expect.poll(() => messages.length).toBe(1);
    expect(messages[0]).toMatchObject({
      type: 'ban_applied',
      banId,
      banType: 'SHADOW',
      visitorId: visitor.id,
    });
    await unsubscribe();

    expect(await bans.revoke(banId)).toBe(true);
    expect(await redis.exists(banVisitorKey(visitor.id))).toBe(0);
    expect(await bans.revoke(banId)).toBe(false);
  });

  it('resolves a device ban to the visitor using that device', async () => {
    const visitor = await newVisitor();
    const messages: GwControlMessage[] = [];
    const unsubscribe = await subscribeControl(
      subscriber,
      { onMessage: (m) => messages.push(m) },
      channel,
    );
    const { banId } = await bans.apply({
      deviceIdHash: visitor.deviceIdHash,
      type: 'HARD',
      reason: 'test',
      expiresAt: null,
    });
    await expect.poll(() => messages.length).toBe(1);
    expect(messages[0]).toMatchObject({
      banId,
      visitorId: visitor.id,
      deviceIdHash: visitor.deviceIdHash,
    });
    expect(await redis.exists(banDeviceKey(visitor.deviceIdHash))).toBe(1);
    await unsubscribe();
  });
});

describe('trust store & risk profiles', () => {
  it('adjusts trust atomically within 0–100 and caches it', async () => {
    const visitor = await newVisitor(15);
    expect(await trust.adjust(visitor.id, -20)).toBe(0);
    expect(await redis.get(trustKey(visitor.id))).toBe('0');
    expect(await trust.adjust(visitor.id, 150)).toBe(100);
    await redis.del(trustKey(visitor.id));
    expect(await trust.get(visitor.id)).toBe(100); // from Postgres, re-cached
    expect(await redis.get(trustKey(visitor.id))).toBe('100');
    expect(await trust.adjust(randomUUID(), -5)).toBeNull();
  });

  it('merges risk profile updates and keeps the latest flag', async () => {
    const visitor = await newVisitor();
    await risk.seen(visitor.id, new Date(1_000));
    await risk.flag(visitor.id, 5_000);
    await risk.flag(visitor.id, 3_000);
    await risk.reported(visitor.id, 4_000);
    expect(await risk.profile(visitor.id, 42)).toEqual({
      trust: 42,
      firstSeenAt: 1_000,
      flaggedUntil: 5_000,
      lastReportedAt: 4_000,
    });
    expect(await redis.ttl(riskProfileKey(visitor.id))).toBeGreaterThan(7 * 24 * 3600);
  });
});
