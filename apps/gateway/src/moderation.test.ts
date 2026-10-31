import { randomUUID } from 'node:crypto';

import {
  banVisitorKey,
  MOD_BUDGET_MULTIPLIER_KEY,
  publishControl,
  riskProfileKey,
  sessionKeys,
  trustKey,
} from '@app/redis';
import { type MatchFound, type PeerLeft, type SupportedLang, type SystemNotice } from '@app/shared';
import { type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Gateway } from './gateway.ts';
import { createGatewayModeration } from './moderation.ts';
import {
  appRedis,
  connected,
  CONTROL_CHANNEL,
  newVisitorId,
  nextEvent,
  prisma,
  startGateway,
  testConfig,
  tokenFor,
} from './test/helpers.ts';

interface AckResult {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

let nodeA: { gateway: Gateway; url: string };
let nodeB: { gateway: Gateway; url: string };
const clients: ClientSocket[] = [];
const ids = new WeakMap<ClientSocket, string>();
const DAY = 24 * 60 * 60 * 1000;

async function visitor(url: string, visitorId = newVisitorId()): Promise<ClientSocket> {
  const socket = await connected(url, await tokenFor(visitorId));
  ids.set(socket, visitorId);
  clients.push(socket);
  await ack(socket, 'ping', {});
  return socket;
}

const idOf = (socket: ClientSocket) => ids.get(socket) ?? '';

async function ack(socket: ClientSocket, event: string, payload: unknown): Promise<AckResult> {
  return (await socket.timeout(3_000).emitWithAck(event, payload)) as AckResult;
}

async function pair(
  lang: SupportedLang,
  a: ClientSocket,
  b: ClientSocket,
  mode: 'text' | 'video' = 'video',
) {
  const join = { mode, lang, autoRequeue: false };
  const waiting = nextEvent(a, 'queue:waiting');
  expect(await ack(a, 'queue:join', join)).toEqual({ ok: true });
  await waiting;
  const foundA = nextEvent<MatchFound>(a, 'match:found');
  const foundB = nextEvent<MatchFound>(b, 'match:found');
  expect(await ack(b, 'queue:join', join)).toEqual({ ok: true });
  const [matchA, matchB] = await Promise.all([foundA, foundB]);
  await ack(a, 'match:ack', { sessionId: matchA.sessionId });
  await ack(b, 'match:ack', { sessionId: matchB.sessionId });
  return { matchA, matchB };
}

/** What the API writes at session start / the worker after reports. */
async function profile(
  visitorId: string,
  trust: number,
  firstSeenAt: number,
  flaggedUntil: number | null = null,
) {
  await appRedis.set(trustKey(visitorId), String(trust));
  await appRedis.set(
    riskProfileKey(visitorId),
    JSON.stringify({ firstSeenAt, flaggedUntil, lastReportedAt: null }),
  );
}

const shadowBan = (visitorId: string) =>
  appRedis.set(
    banVisitorKey(visitorId),
    JSON.stringify({ banned: true, banId: randomUUID(), type: 'SHADOW', expiresAt: null }),
  );

beforeAll(async () => {
  await appRedis.flushdb();
  nodeA = await startGateway('ma');
  nodeB = await startGateway('mb');
});

afterAll(async () => {
  for (const socket of clients) socket.disconnect();
  await Promise.all([nodeA.gateway.shutdown(), nodeB.gateway.shutdown()]);
  await prisma.$disconnect();
  await appRedis.quit();
});

describe('text filter on the relay path', () => {
  it('blocks links (notice + ack error + moderation event), masks profanity', async () => {
    const a = await visitor(nodeA.url);
    const b = await visitor(nodeB.url);
    const { matchA } = await pair('en', a, b);
    const notice = nextEvent<SystemNotice>(a, 'system:notice');
    let leaked = false;
    b.on('chat:message', (m: { text: string }) => {
      if (m.text.includes('example')) leaked = true;
    });
    expect(
      await ack(a, 'chat:message', {
        sessionId: matchA.sessionId,
        text: 'go to w w w . example . com',
        clientMsgId: 'c1',
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'MESSAGE_BLOCKED' },
    });
    expect(await notice).toMatchObject({
      code: 'MESSAGE_BLOCKED',
      message: 'Links aren’t allowed in chat.',
    });
    await expect
      .poll(async () =>
        (await nodeA.gateway.moderationQueue.getJobs(['waiting'])).map((j) => j.data),
      )
      .toContainEqual(
        expect.objectContaining({
          visitorId: idOf(a),
          source: 'TEXT_FILTER',
          label: 'link',
          trustEvent: 'text_violation',
        }),
      );

    const relayed = nextEvent<{ text: string }>(b, 'chat:message');
    const sent = await ack(a, 'chat:message', {
      sessionId: matchA.sessionId,
      text: 'holy shit',
      clientMsgId: 'c2',
    });
    expect(sent).toMatchObject({ ok: true, data: { text: 'holy ****' } });
    expect((await relayed).text).toBe('holy ****');
    expect(leaked).toBe(false);
  });
});

describe('bans applied live (gw:control ban_applied)', () => {
  it('HARD: the visitor is told and disconnected on any node; the stranger just sees them leave', async () => {
    const a = await visitor(nodeA.url);
    const b = await visitor(nodeB.url);
    const { matchB } = await pair('pt', a, b);
    const notice = nextEvent<SystemNotice>(a, 'system:notice');
    const disconnected = nextEvent<string>(a, 'disconnect');
    const peerLeft = nextEvent<PeerLeft>(b, 'peer:left');
    await publishControl(
      appRedis,
      {
        type: 'ban_applied',
        originNodeId: 'test',
        banId: randomUUID(),
        banType: 'HARD',
        visitorId: idOf(a),
        expiresAt: null,
      },
      CONTROL_CHANNEL,
    );
    expect(await notice).toMatchObject({ code: 'BANNED' });
    expect(await disconnected).toBe('io server disconnect');
    expect(await peerLeft).toMatchObject({
      sessionId: matchB.sessionId,
      reason: 'left',
      sessionEnded: true,
    });
  });

  it('SHADOW: the chat ends silently and the next search happens in the shadow pool', async () => {
    const a = await visitor(nodeA.url);
    const b = await visitor(nodeB.url);
    const { matchA, matchB } = await pair('fr', a, b);
    await shadowBan(idOf(a)); // BanService writes the cache before publishing
    const ownEnd = nextEvent<PeerLeft>(a, 'peer:left');
    const peerLeft = nextEvent<PeerLeft>(b, 'peer:left');
    await publishControl(
      appRedis,
      {
        type: 'ban_applied',
        originNodeId: 'test',
        banId: randomUUID(),
        banType: 'SHADOW',
        visitorId: idOf(a),
        expiresAt: null,
      },
      CONTROL_CHANNEL,
    );
    // a only sees "the stranger disconnected", never the ban.
    expect(await ownEnd).toMatchObject({
      sessionId: matchA.sessionId,
      participantId: matchB.selfParticipantId,
      reason: 'disconnected',
      sessionEnded: true,
    });
    expect(await peerLeft).toMatchObject({ sessionId: matchB.sessionId, reason: 'left' });
    expect(a.connected).toBe(true);

    // Both search again: b (normal) and a (shadow) must not meet.
    await ack(b, 'queue:join', { mode: 'video', lang: 'fr' });
    let matched = false;
    a.on('match:found', () => (matched = true));
    expect(await ack(a, 'queue:join', { mode: 'video', lang: 'fr' })).toEqual({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(matched).toBe(false);
    await Promise.all([ack(a, 'queue:leave', {}), ack(b, 'queue:leave', {})]);
  });

  it('shadow-banned (or low-trust) visitors are only matched with each other', async () => {
    const xId = newVisitorId();
    const yId = newVisitorId();
    await shadowBan(xId);
    await appRedis.set(trustKey(yId), '5'); // below TRUST_SHADOW_BELOW → shadow pool
    const x = await visitor(nodeA.url, xId);
    const n = await visitor(nodeB.url);
    const y = await visitor(nodeB.url, yId);
    const join = { mode: 'video', lang: 'nl' };
    let normalMatched = false;
    n.on('match:found', () => (normalMatched = true));
    await ack(x, 'queue:join', join);
    await ack(n, 'queue:join', join);
    const foundX = nextEvent<MatchFound>(x, 'match:found');
    const foundY = nextEvent<MatchFound>(y, 'match:found');
    await ack(y, 'queue:join', join);
    const [mx, my] = await Promise.all([foundX, foundY]);
    expect(mx.sessionId).toBe(my.sessionId);
    expect(normalMatched).toBe(false);
    await ack(n, 'queue:leave', {});
  });
});

describe('risk-based frame sampling', () => {
  it('assigns intervals by tier in match:found and in the participant records', async () => {
    const riskyId = newVisitorId();
    const newcomerId = newVisitorId();
    await profile(riskyId, 20, Date.now() - 30 * DAY); // trust < 40 → high
    await profile(newcomerId, 60, Date.now() - 60_000); // first day → new
    const risky = await visitor(nodeA.url, riskyId);
    const newcomer = await visitor(nodeB.url, newcomerId);
    const { matchA, matchB } = await pair('pl', risky, newcomer);
    expect(matchA.moderation).toEqual({ frameIntervalMs: 20_000, maxFrames: null });
    expect(matchB.moderation).toEqual({ frameIntervalMs: 30_000, maxFrames: null });
    const record = JSON.parse(
      (await appRedis.hget(sessionKeys(matchA.sessionId).participants, matchA.selfParticipantId)) ??
        '{}',
    ) as { frameIntervalMs?: number; tier?: string };
    expect(record).toMatchObject({ frameIntervalMs: 20_000, tier: 'high' });

    // Text chats are never sampled.
    const t1 = await visitor(nodeA.url, riskyId);
    const t2 = await visitor(nodeB.url);
    const text = await pair('tr', t1, t2, 'text');
    expect(text.matchA.moderation.frameIntervalMs).toBeNull();
  });

  it('a strong client NSFW signal raises everyone in the session to high, rate-limited', async () => {
    const aId = newVisitorId();
    const bId = newVisitorId();
    await profile(aId, 60, Date.now() - 60_000);
    await profile(bId, 60, Date.now() - 60_000);
    const a = await visitor(nodeA.url, aId);
    const b = await visitor(nodeB.url, bId);
    const { matchA } = await pair('ru', a, b);
    expect(matchA.moderation.frameIntervalMs).toBe(30_000);
    const noticeA = nextEvent<SystemNotice>(a, 'system:notice');
    const noticeB = nextEvent<SystemNotice>(b, 'system:notice');
    const signal = {
      sessionId: matchA.sessionId,
      about: matchA.peers[0]?.participantId,
      kind: 'porn',
      score: 0.97,
    };
    expect(await ack(a, 'moderation:signal', signal)).toEqual({ ok: true });
    for (const notice of [await noticeA, await noticeB]) {
      expect(notice).toMatchObject({
        code: 'FRAME_SCHEDULE',
        sessionId: matchA.sessionId,
        moderation: { frameIntervalMs: 20_000 },
      });
    }
    expect(await ack(a, 'moderation:signal', signal)).toMatchObject({
      ok: false,
      error: { code: 'RATE_LIMITED' },
    });
    const jobs = (await nodeA.gateway.moderationQueue.getJobs(['waiting'])).map((j) => j.data);
    expect(jobs).toContainEqual(
      expect.objectContaining({ visitorId: bId, source: 'CLIENT_NSFW', trustEvent: null }),
    );
  });

  it('stretches intervals with the global budget multiplier (low tiers first, high ≤ 2×)', async () => {
    let now = new Date('2026-10-31T12:00:00.000Z');
    const moderation = createGatewayModeration({
      redis: appRedis,
      config: testConfig,
      enqueueEvent: () => Promise.resolve(),
      now: () => now,
      random: () => 0,
    });
    const visitorIdOf = { high: newVisitorId(), newcomer: newVisitorId(), normal: newVisitorId() };
    await profile(visitorIdOf.high, 10, now.getTime() - 30 * DAY);
    await profile(visitorIdOf.newcomer, 50, now.getTime() - 1_000);
    await profile(visitorIdOf.normal, 50, now.getTime() - 30 * DAY);
    await appRedis.set(MOD_BUDGET_MULTIPLIER_KEY, '8');
    const interval = async (visitorId: string) =>
      (await moderation.scheduleFor(visitorId, { mode: 'video' })).frameIntervalMs;
    expect(await interval(visitorIdOf.high)).toBe(40_000);
    expect(await interval(visitorIdOf.newcomer)).toBe(120_000);
    expect(await interval(visitorIdOf.normal)).toBe(960_000);
    expect(
      (await moderation.scheduleFor(visitorIdOf.high, { mode: 'video', groupCall: true })).tier,
    ).toBe('high');

    await appRedis.set(MOD_BUDGET_MULTIPLIER_KEY, '1');
    expect(await interval(visitorIdOf.high)).toBe(40_000); // cached for 5 s
    now = new Date(now.getTime() + 6_000);
    expect(await interval(visitorIdOf.high)).toBe(20_000);
    await appRedis.del(MOD_BUDGET_MULTIPLIER_KEY);
  });
});
