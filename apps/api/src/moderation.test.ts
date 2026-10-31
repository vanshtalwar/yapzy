import { randomBytes, randomUUID } from 'node:crypto';

import { reportPriority } from '@app/moderation';
import {
  banVisitorKey,
  moderationFramesKey,
  riskProfileKey,
  sessionKeys,
  trustKey,
  visitorSessionKey,
} from '@app/redis';
import { createMemoryObjectStore } from '@app/storage';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { type App } from './app.ts';
import { createRecordingJobs } from './services/jobs.ts';
import {
  buildTestApp,
  createFakeClock,
  prisma,
  randomTestIp,
  redis,
  testConfig,
} from './test/helpers.ts';

const clock = createFakeClock();
const objects = createMemoryObjectStore();
const jobs = createRecordingJobs();
let app: App;
const deviceHashes: string[] = [];

interface Visitor {
  id: string;
  token: string;
}

async function visitor(): Promise<Visitor> {
  const deviceId = randomUUID();
  const response = await app.inject({
    method: 'POST',
    url: '/v1/session',
    remoteAddress: randomTestIp(),
    payload: {
      turnstileToken: 'ok',
      ageConfirmed: true,
      tosVersion: testConfig.TOS_VERSION,
      deviceId,
    },
  });
  expect(response.statusCode).toBe(200);
  const body = response.json<{ token: string; visitorId: string }>();
  const row = await prisma.visitor.findUniqueOrThrow({ where: { id: body.visitorId } });
  deviceHashes.push(row.deviceIdHash);
  return { id: body.visitorId, token: body.token };
}

const PA = 'pReporter001';
const PB = 'pReported001';

/** A session as the gateway would have written it (video, A sampled every 20 s). */
async function session(
  a: Visitor,
  b: Visitor,
  opts: { mode?: 'text' | 'video'; frames?: { a?: number | null; maxFrames?: number } } = {},
) {
  const sessionId = randomUUID();
  const keys = sessionKeys(sessionId);
  await redis.hset(keys.meta, {
    mode: opts.mode ?? 'video',
    state: 'active',
    startedAt: String(clock.now().getTime()),
  });
  const record = (visitorId: string, frameIntervalMs: number | null, maxFrames?: number) =>
    JSON.stringify({
      visitorId,
      status: 'active',
      joinedAt: 0,
      pool: 'normal',
      interests: [],
      autoRequeue: false,
      frameIntervalMs,
      ...(maxFrames === undefined ? {} : { maxFrames }),
    });
  await redis.hset(
    keys.participants,
    PA,
    record(a.id, opts.frames?.a === undefined ? 20_000 : opts.frames.a, opts.frames?.maxFrames),
  );
  await redis.hset(keys.participants, PB, record(b.id, null));
  await redis.set(visitorSessionKey(a.id), JSON.stringify({ sessionId, participantId: PA }));
  await redis.set(visitorSessionKey(b.id), JSON.stringify({ sessionId, participantId: PB }));
  for (const [from, text] of [
    [PA, 'hi'],
    [PB, 'send pics'],
    [PA, 'no'],
  ] as const) {
    await redis.rpush(
      keys.log,
      JSON.stringify({ sessionId, from, id: randomUUID(), text, at: clock.now().toISOString() }),
    );
  }
  return sessionId;
}

const jpeg = (width = 320, height = 240) =>
  sharp({ create: { width, height, channels: 3, background: '#4060a0' } })
    .jpeg()
    .toBuffer();

async function multipart(fields: Record<string, string>, files: Buffer[] = []) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  files.forEach((file, index) => {
    form.append(
      'frames',
      new Blob([new Uint8Array(file)], { type: 'image/jpeg' }),
      `${String(index)}.jpg`,
    );
  });
  const response = new Response(form);
  return {
    payload: Buffer.from(await response.arrayBuffer()),
    headers: { 'content-type': response.headers.get('content-type') ?? '' },
  };
}

async function report(reporter: Visitor, fields: Record<string, string>, files: Buffer[] = []) {
  const body = await multipart(fields, files);
  return app.inject({
    method: 'POST',
    url: '/v1/reports',
    headers: { ...body.headers, authorization: `Bearer ${reporter.token}` },
    payload: body.payload,
  });
}

function uploadFrame(who: Visitor, sessionId: string, body: Buffer, contentType = 'image/jpeg') {
  return app.inject({
    method: 'POST',
    url: `/v1/moderation/frames?sessionId=${sessionId}`,
    headers: { authorization: `Bearer ${who.token}`, 'content-type': contentType },
    payload: body,
  });
}

beforeAll(async () => {
  app = await buildTestApp({ clock, objects, jobs });
});

beforeEach(async () => {
  await redis.flushdb();
  jobs.recorded.reportFiled.length = 0;
  jobs.recorded.classifyFrame.length = 0;
});

afterAll(async () => {
  const visitors = await prisma.visitor.findMany({
    where: { deviceIdHash: { in: deviceHashes } },
    select: { id: true },
  });
  const ids = visitors.map((v) => v.id);
  await prisma.report.deleteMany({
    where: { OR: [{ reporterId: { in: ids } }, { reportedId: { in: ids } }] },
  });
  await prisma.visitor.deleteMany({ where: { id: { in: ids } } });
  await app.close();
  await prisma.$disconnect();
  await redis.quit();
});

describe('session creation caches trust and risk for the gateway', () => {
  it('writes trust:<id> and risk:<id>', async () => {
    const v = await visitor();
    expect(await redis.get(trustKey(v.id))).toBe('50');
    expect(JSON.parse((await redis.get(riskProfileKey(v.id))) ?? '{}')).toMatchObject({
      firstSeenAt: clock.now().getTime(),
      flaggedUntil: null,
    });
  });
});

describe('POST /v1/reports', () => {
  it('refuses HARD-banned reporters (their token outlives the ban)', async () => {
    const [a, b] = [await visitor(), await visitor()];
    const sessionId = await session(a, b);
    await redis.set(
      banVisitorKey(a.id),
      JSON.stringify({ banned: true, banId: randomUUID(), type: 'HARD', expiresAt: null }),
    );
    const response = await report(a, { sessionId, reportedParticipantId: PB, reason: 'OTHER' });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'BANNED' } });
    expect(jobs.recorded.reportFiled).toEqual([]);
  });

  it('rejects people who were not in the chat, and reporting yourself', async () => {
    const [a, b, stranger] = [await visitor(), await visitor(), await visitor()];
    const sessionId = await session(a, b);
    const fields = { sessionId, reportedParticipantId: PB, reason: 'HARASSMENT' };
    expect((await report(stranger, fields)).statusCode).toBe(403);
    expect((await report(a, { ...fields, reportedParticipantId: PA })).statusCode).toBe(403);
    expect((await report(a, { ...fields, sessionId: randomUUID() })).statusCode).toBe(403);
    expect((await report(a, { ...fields, reason: 'BORING' })).statusCode).toBe(400);
    expect(jobs.recorded.reportFiled).toEqual([]);
  });

  it('validates frames: JPEG only, ≤ 300 KB, ≤ 3', async () => {
    const [a, b] = [await visitor(), await visitor()];
    const sessionId = await session(a, b);
    const fields = { sessionId, reportedParticipantId: PB, reason: 'NUDITY_SEXUAL' };
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } })
      .png()
      .toBuffer();
    expect((await report(a, fields, [png])).statusCode).toBe(400);
    expect(
      (await report(a, fields, [Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), randomBytes(64)])]))
        .statusCode,
    ).toBe(400);
    const tooBig = Buffer.concat([await jpeg(), randomBytes(310 * 1024)]);
    expect((await report(a, fields, [tooBig])).statusCode).toBe(413);
    const frame = await jpeg();
    expect((await report(a, fields, [frame, frame, frame, frame])).statusCode).toBe(413);
  });

  it('stores the report with transcript, re-encoded evidence and priority', async () => {
    const [a, b] = [await visitor(), await visitor()];
    const sessionId = await session(a, b);
    // A JPEG carrying EXIF metadata (e.g. GPS) — it must not survive into the evidence store.
    const withExif = await sharp({
      create: { width: 640, height: 480, channels: 3, background: '#a04040' },
    })
      .withExif({ IFD0: { Copyright: 'secret-location' } })
      .jpeg()
      .toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeDefined();

    const response = await report(
      a,
      { sessionId, reportedParticipantId: PB, reason: 'MINOR_SAFETY', details: '  asked my age  ' },
      [withExif, await jpeg()],
    );
    expect(response.statusCode).toBe(201);
    const { reportId } = response.json<{ reportId: string }>();

    const row = await prisma.report.findUniqueOrThrow({
      where: { id: reportId },
      include: { evidence: true },
    });
    expect(row).toMatchObject({
      sessionId,
      reporterId: a.id,
      reportedId: b.id,
      reportedParticipantId: PB,
      reason: 'MINOR_SAFETY',
      details: 'asked my age',
      status: 'OPEN',
      priority: reportPriority('MINOR_SAFETY', 0),
    });
    expect(row.transcript).toEqual([
      expect.objectContaining({ from: 'reporter', text: 'hi' }),
      expect.objectContaining({ from: 'reported', text: 'send pics' }),
      expect.objectContaining({ from: 'reporter', text: 'no' }),
    ]);
    expect(row.evidence).toHaveLength(2);
    for (const evidence of row.evidence) {
      expect(evidence).toMatchObject({
        type: 'FRAME',
        storageKey: expect.stringMatching(
          new RegExp(`^reports/${reportId}/[12]\\.jpg$`),
        ) as unknown,
      });
      const stored = objects.objects.get(`${testConfig.S3_BUCKET_EVIDENCE}/${evidence.storageKey}`);
      expect(stored?.contentType).toBe('image/jpeg');
      expect((await sharp(stored?.body).metadata()).exif).toBeUndefined();
      expect(evidence.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(evidence.expiresAt?.getTime()).toBeGreaterThan(clock.now().getTime());
    }
    expect(jobs.recorded.reportFiled).toEqual([
      { reportId, reportedId: b.id, reporterId: a.id, sessionId, at: clock.now().toISOString() },
    ]);

    // Reporting the same chat again is idempotent: same report, no new job.
    const repeat = await report(a, { sessionId, reportedParticipantId: PB, reason: 'HARASSMENT' });
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json()).toEqual({ reportId });
    expect(jobs.recorded.reportFiled).toHaveLength(1);

    // A second report against the same visitor within 24 h is reviewed sooner.
    const c = await visitor();
    const second = await session(c, b);
    const again = await report(c, {
      sessionId: second,
      reportedParticipantId: PB,
      reason: 'HARASSMENT',
    });
    const secondRow = await prisma.report.findUniqueOrThrow({
      where: { id: again.json<{ reportId: string }>().reportId },
    });
    expect(secondRow.priority).toBe(reportPriority('HARASSMENT', 1));
    expect(secondRow.priority).toBeGreaterThan(reportPriority('HARASSMENT', 0));
  });
});

describe('POST /v1/moderation/frames', () => {
  it('accepts frames only at the assigned interval and queues them for classification', async () => {
    const [a, b] = [await visitor(), await visitor()];
    const sessionId = await session(a, b);
    const frame = await jpeg();

    const first = await uploadFrame(a, sessionId, frame);
    expect(first.statusCode).toBe(202);
    expect(jobs.recorded.classifyFrame).toEqual([
      expect.objectContaining({ sessionId, participantId: PA, visitorId: a.id }),
    ]);
    const key = jobs.recorded.classifyFrame[0]?.storageKey ?? '';
    expect(objects.objects.has(`${testConfig.S3_BUCKET_FRAMES}/${key}`)).toBe(true);

    // Faster than the assigned 20 s (minus 20 % jitter allowance) is refused.
    expect((await uploadFrame(a, sessionId, frame)).statusCode).toBe(429);
    clock.advance(15_000);
    expect((await uploadFrame(a, sessionId, frame)).statusCode).toBe(429);
    clock.advance(1_000);
    expect((await uploadFrame(a, sessionId, frame)).statusCode).toBe(202);
    expect(jobs.recorded.classifyFrame).toHaveLength(2);

    const window = Math.floor(clock.now().getTime() / 10_000) * 10;
    const counted =
      Number((await redis.get(moderationFramesKey(window))) ?? '0') +
      Number((await redis.get(moderationFramesKey(window - 10))) ?? '0') +
      Number((await redis.get(moderationFramesKey(window - 20))) ?? '0');
    expect(counted).toBe(2);
  });

  it('refuses visitors without a schedule, text chats, bad images and spent spot checks', async () => {
    const [a, b] = [await visitor(), await visitor()];
    const sessionId = await session(a, b);
    const frame = await jpeg();
    expect((await uploadFrame(b, sessionId, frame)).statusCode).toBe(403); // not sampled
    expect((await uploadFrame(a, randomUUID(), frame)).statusCode).toBe(403); // other session
    expect((await uploadFrame(a, sessionId, await jpeg(640, 480))).statusCode).toBe(400);
    expect((await uploadFrame(a, sessionId, Buffer.from('not an image'))).statusCode).toBe(400);
    expect((await uploadFrame(a, sessionId, frame, 'image/png')).statusCode).toBe(415);
    expect(
      (await uploadFrame(a, sessionId, Buffer.concat([frame, randomBytes(70 * 1024)]))).statusCode,
    ).toBe(413);

    const [c, d] = [await visitor(), await visitor()];
    const text = await session(c, d, { mode: 'text' });
    expect((await uploadFrame(c, text, frame)).statusCode).toBe(403);

    const [e, f] = [await visitor(), await visitor()];
    const spot = await session(e, f, { frames: { a: 10_000, maxFrames: 1 } });
    expect((await uploadFrame(e, spot, frame)).statusCode).toBe(202);
    clock.advance(60_000);
    const spent = await uploadFrame(e, spot, frame);
    expect(spent.statusCode).toBe(429);
    expect(spent.json<{ error: { message: string } }>().error.message).toBe(
      'No more frames are expected',
    );
  });
});
