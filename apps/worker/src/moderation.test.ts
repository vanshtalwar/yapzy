import { randomBytes, randomUUID } from 'node:crypto';

import { MockImageClassifier } from '@app/moderation';
import {
  banVisitorKey,
  type GwControlMessage,
  MOD_BUDGET_MULTIPLIER_KEY,
  moderationFramesKey,
  riskProfileKey,
  sessionKeys,
  subscribeControl,
  trustKey,
} from '@app/redis';
import { createTestRedis } from '@app/redis/testing';
import { type SessionLogJob } from '@app/shared/jobs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { updateBudgetMultiplier } from './moderation/budget.ts';
import { classifyFrame } from './moderation/classify-frame.ts';
import { recordModerationEvent } from './moderation/moderation-event.ts';
import { handleReportFiled } from './moderation/report-filed.ts';
import { applySessionTrust } from './moderation/session-trust.ts';
import {
  moderationDeps,
  testControlChannel,
  testPrisma as prisma,
  testRedis as redis,
} from './test/moderation.ts';

const subscriber = createTestRedis('worker-moderation-sub', { dbIndex: 9 });
const visitorIds: string[] = [];
const NOW = new Date('2026-10-31T12:00:00.000Z');

async function newVisitor(trustScore = 50): Promise<string> {
  const visitor = await prisma.visitor.create({
    data: { deviceIdHash: randomBytes(32).toString('hex'), trustScore },
  });
  visitorIds.push(visitor.id);
  return visitor.id;
}

const frameJob = (visitorId: string, sessionId = randomUUID()) => ({
  storageKey: `${sessionId}/pFlagged0001/1.jpg`,
  sessionId,
  participantId: 'pFlagged0001',
  visitorId,
  receivedAt: NOW.toISOString(),
});

beforeEach(async () => {
  await redis.flushdb();
});

afterAll(async () => {
  await prisma.ban.deleteMany({ where: { visitorId: { in: visitorIds } } });
  await prisma.report.deleteMany({ where: { reportedId: { in: visitorIds } } });
  await prisma.visitor.deleteMany({ where: { id: { in: visitorIds } } });
  await prisma.$disconnect();
  await Promise.all([redis.quit(), subscriber.quit()]);
});

describe('classify-frame', () => {
  it('deletes clean frames right away', async () => {
    const deps = moderationDeps();
    const visitorId = await newVisitor();
    const job = frameJob(visitorId);
    await deps.objects.put(
      'frames',
      job.storageKey,
      new Uint8Array([0xff, 0xd8, 0xff]),
      'image/jpeg',
    );
    expect(await classifyFrame(deps, job)).toBe('clean');
    expect(deps.objects.objects.size).toBe(0);
    expect(await prisma.moderationEvent.count({ where: { visitorId } })).toBe(0);
    expect(await classifyFrame(deps, job)).toBe('missing');
  });

  it('a forced flag becomes evidence, an automatic report, a trust drop and a live shadow ban', async () => {
    const visitorId = await newVisitor(50);
    const deps = moderationDeps({
      classifier: new MockImageClassifier([visitorId]),
      now: () => NOW,
    });
    const messages: GwControlMessage[] = [];
    const unsubscribe = await subscribeControl(
      subscriber,
      { onMessage: (m) => messages.push(m) },
      testControlChannel,
    );
    const job = frameJob(visitorId);
    await redis.rpush(
      sessionKeys(job.sessionId).log,
      JSON.stringify({ id: 'm1', at: NOW.toISOString(), from: 'pFlagged0001', text: 'hey' }),
    );
    await deps.objects.put(
      'frames',
      job.storageKey,
      new Uint8Array([0xff, 0xd8, 0xff, 7]),
      'image/jpeg',
    );

    expect(await classifyFrame(deps, job)).toBe('flagged');

    const event = await prisma.moderationEvent.findFirstOrThrow({ where: { visitorId } });
    expect(event).toMatchObject({
      source: 'SERVER_CLASSIFIER',
      label: 'sexual_explicit',
      actionTaken: 'SHADOW_BANNED',
      sessionId: job.sessionId,
    });
    const report = await prisma.report.findFirstOrThrow({
      where: { reportedId: visitorId },
      include: { evidence: true },
    });
    expect(report).toMatchObject({
      reporterId: null,
      reason: 'NUDITY_SEXUAL',
      reportedParticipantId: 'pFlagged0001',
      status: 'OPEN',
    });
    expect(report.priority).toBeGreaterThan(80);
    expect(report.transcript).toEqual([expect.objectContaining({ text: 'hey' })]);
    expect(report.evidence).toEqual([
      expect.objectContaining({
        type: 'AUTO_FLAG_FRAME',
        moderationEventId: event.id,
        storageKey: `auto/${event.id}.jpg`,
      }),
    ]);
    // Moved out of the 1-day frames bucket into evidence.
    expect([...deps.objects.objects.keys()]).toEqual([`evidence/auto/${event.id}.jpg`]);

    expect(await redis.get(trustKey(visitorId))).toBe('30');
    expect(JSON.parse((await redis.get(riskProfileKey(visitorId))) ?? '{}')).toMatchObject({
      flaggedUntil: NOW.getTime() + 24 * 3_600_000,
    });
    const ban = await prisma.ban.findFirstOrThrow({ where: { visitorId } });
    expect(ban).toMatchObject({ type: 'SHADOW', revokedAt: null });
    expect(JSON.parse((await redis.get(banVisitorKey(visitorId))) ?? '{}')).toMatchObject({
      banned: true,
      type: 'SHADOW',
    });
    await expect.poll(() => messages.length).toBe(1);
    expect(messages[0]).toMatchObject({
      type: 'ban_applied',
      banId: ban.id,
      banType: 'SHADOW',
      visitorId,
    });
    await unsubscribe();
  });

  it('a flag below the auto-ban score only lowers trust', async () => {
    const visitorId = await newVisitor(50);
    const deps = moderationDeps({
      classifier: new MockImageClassifier([visitorId]),
      config: { flagThreshold: 0.8, autoShadowScore: 0.995, reportThreshold: 3, autoBanHours: 168 },
    });
    const job = frameJob(visitorId);
    await deps.objects.put(
      'frames',
      job.storageKey,
      new Uint8Array([0xff, 0xd8, 0xff]),
      'image/jpeg',
    );
    expect(await classifyFrame(deps, job)).toBe('flagged');
    expect(await prisma.ban.count({ where: { visitorId } })).toBe(0);
    expect(
      (await prisma.moderationEvent.findFirstOrThrow({ where: { visitorId } })).actionTaken,
    ).toBe('TRUST_DECREASED');
  });

  it('a hash match is escalated: permanent HARD ban and evidence kept without expiry', async () => {
    const visitorId = await newVisitor();
    const deps = moderationDeps({
      hashMatcher: {
        match: () => Promise.resolve({ matched: true, list: 'test-list', reference: 'ref-1' }),
      },
    });
    const job = frameJob(visitorId);
    await deps.objects.put(
      'frames',
      job.storageKey,
      new Uint8Array([0xff, 0xd8, 0xff]),
      'image/jpeg',
    );
    expect(await classifyFrame(deps, job)).toBe('hash_match');
    expect(await prisma.ban.findFirstOrThrow({ where: { visitorId } })).toMatchObject({
      type: 'HARD',
      expiresAt: null,
    });
    const report = await prisma.report.findFirstOrThrow({
      where: { reportedId: visitorId },
      include: { evidence: true },
    });
    expect(report).toMatchObject({ reason: 'MINOR_SAFETY', priority: 1_000 });
    expect(report.evidence[0]?.expiresAt).toBeNull();
    expect(
      (await prisma.moderationEvent.findFirstOrThrow({ where: { visitorId } })).actionTaken,
    ).toBe('ESCALATED');
  });
});

describe('report-filed', () => {
  it('lowers trust per report and shadow-bans at 3 distinct reporters within 24 h', async () => {
    const deps = moderationDeps();
    const reported = await newVisitor(50);
    const sessionId = randomUUID();
    let last = { reporters: 0, shadowBanned: false };
    for (let index = 0; index < 3; index += 1) {
      const reporter = await newVisitor();
      const report = await prisma.report.create({
        data: {
          sessionId,
          reporterId: reporter,
          reportedId: reported,
          reportedParticipantId: 'pReported001',
          reason: 'HARASSMENT',
        },
      });
      last = await handleReportFiled(deps, {
        reportId: report.id,
        reportedId: reported,
        reporterId: reporter,
        sessionId,
        at: new Date().toISOString(),
      });
    }
    expect(last).toEqual({ reporters: 3, shadowBanned: true });
    expect(await redis.get(trustKey(reported))).toBe('20');
    expect(await prisma.ban.findFirstOrThrow({ where: { visitorId: reported } })).toMatchObject({
      type: 'SHADOW',
    });
    expect(
      await prisma.moderationEvent.findFirstOrThrow({ where: { visitorId: reported } }),
    ).toMatchObject({
      source: 'REPORT_THRESHOLD',
      actionTaken: 'SHADOW_BANNED',
    });
  });

  it('charges one reporter at most once a day, however many reports they file', async () => {
    const deps = moderationDeps();
    const reported = await newVisitor(50);
    const reporter = await newVisitor();
    for (let index = 0; index < 5; index += 1) {
      const sessionId = randomUUID();
      const report = await prisma.report.create({
        data: {
          sessionId,
          reporterId: reporter,
          reportedId: reported,
          reportedParticipantId: 'pReported002',
          reason: 'HARASSMENT',
        },
      });
      expect(
        await handleReportFiled(deps, {
          reportId: report.id,
          reportedId: reported,
          reporterId: reporter,
          sessionId,
          at: new Date().toISOString(),
        }),
      ).toEqual({ reporters: 1, shadowBanned: false });
    }
    // 50 − 10 once (not 50 − 5 × 10 = 0, which would mean the shadow pool).
    expect(await redis.get(trustKey(reported))).toBe('40');
  });
});

describe('moderation-event & session trust', () => {
  it('records events; only text violations change trust', async () => {
    const deps = moderationDeps();
    const visitorId = await newVisitor(50);
    const base = { visitorId, sessionId: randomUUID(), score: 1, at: new Date().toISOString() };
    await recordModerationEvent(deps, {
      ...base,
      source: 'TEXT_FILTER',
      label: 'link',
      action: 'MESSAGE_BLOCKED',
      trustEvent: 'text_violation',
    });
    await recordModerationEvent(deps, {
      ...base,
      source: 'CLIENT_NSFW',
      label: 'porn',
      action: 'NONE',
      trustEvent: null,
    });
    expect(await prisma.moderationEvent.count({ where: { visitorId } })).toBe(2);
    expect(await redis.get(trustKey(visitorId))).toBe('48');
    expect(
      await recordModerationEvent(deps, {
        ...base,
        visitorId: randomUUID(),
        source: 'TEXT_FILTER',
        label: 'x',
        action: 'NONE',
        trustEvent: null,
      }),
    ).toBe('unknown_visitor');
  });

  it('rewards clean sessions and penalises missing frame uploads', async () => {
    const deps = moderationDeps();
    const [clean, dodger, violator] = [
      await newVisitor(50),
      await newVisitor(50),
      await newVisitor(50),
    ];
    const sessionId = randomUUID();
    await prisma.moderationEvent.create({
      data: { visitorId: violator, sessionId, source: 'TEXT_FILTER', label: 'link', score: 1 },
    });
    const start = '2026-10-31T12:00:00.000Z';
    const end = '2026-10-31T12:05:00.000Z';
    const job: SessionLogJob = {
      sessionId,
      mode: 'video',
      topology: 'mesh',
      maxParticipants: 2,
      commonInterests: [],
      startedAt: start,
      endedAt: end,
      participants: [
        {
          participantId: 'pClean000001',
          visitorId: clean,
          joinedAt: start,
          leftAt: end,
          leaveReason: 'STOP',
          frames: { intervalMs: 120_000, maxFrames: null, received: 2 },
        },
        // 5 minutes at one frame per 20 s = 15 expected, only 3 received.
        {
          participantId: 'pDodger00001',
          visitorId: dodger,
          joinedAt: start,
          leftAt: end,
          leaveReason: null,
          frames: { intervalMs: 20_000, maxFrames: null, received: 3 },
        },
        {
          participantId: 'pViolator001',
          visitorId: violator,
          joinedAt: start,
          leftAt: '2026-10-31T12:00:30.000Z',
          leaveReason: 'SKIP',
        },
      ],
    };
    const result = await applySessionTrust(deps, job, new Set([clean, dodger, violator]));
    expect(result).toEqual({ clean: 2, missingFrames: 1 });
    expect(await redis.get(trustKey(clean))).toBe('51');
    expect(await redis.get(trustKey(dodger))).toBe('46'); // +1 clean, −5 missing frames
    expect(await redis.get(trustKey(violator))).toBeNull(); // 30 s and a violation: unchanged
    const dodgerRisk = JSON.parse((await redis.get(riskProfileKey(dodger))) ?? '{}') as {
      flaggedUntil: number;
    };
    expect(dodgerRisk.flaggedUntil).toBeGreaterThan(Date.parse(end));
  });
});

describe('frame budget', () => {
  it('stretches when the accepted frame rate exceeds the budget, and relaxes again', async () => {
    const now = () => new Date('2026-10-31T12:00:05.000Z');
    const window = Math.floor(now().getTime() / 10_000) * 10 - 10;
    await redis.set(moderationFramesKey(window), '2000'); // 200/s against a budget of 50/s
    const up = await updateBudgetMultiplier({
      redis,
      budgetPerSec: 50,
      backlog: () => Promise.resolve(0),
      now,
    });
    expect(up).toBe(2);
    expect(await redis.get(MOD_BUDGET_MULTIPLIER_KEY)).toBe('2');
    // Another worker replica in the same window doesn't compound it (×2 again would be 4).
    expect(
      await updateBudgetMultiplier({
        redis,
        budgetPerSec: 50,
        backlog: () => Promise.resolve(0),
        now,
      }),
    ).toBe(2);
    expect(await redis.get(MOD_BUDGET_MULTIPLIER_KEY)).toBe('2');
    const later = () => new Date(now().getTime() + 10_000);
    await redis.set(moderationFramesKey(window + 10), '50'); // 5/s
    const down = await updateBudgetMultiplier({
      redis,
      budgetPerSec: 50,
      backlog: () => Promise.resolve(0),
      now: later,
    });
    expect(down).toBe(1);
    expect(await redis.ttl(MOD_BUDGET_MULTIPLIER_KEY)).toBeGreaterThan(0);
  });
});
