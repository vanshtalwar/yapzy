import { randomUUID } from 'node:crypto';

import { sessionDeadlinesKey, sessionKeys } from '@app/redis';
import {
  type ChatMessageOut,
  type MatchFound,
  type PeerLeft,
  type PeerPresence,
  type RtcDescriptionOut,
  type SessionResumed,
  type SupportedLang,
  type SystemNotice,
} from '@app/shared';
import { type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Gateway } from './gateway.ts';
import {
  appRedis,
  connected,
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
const visitorIdOf = new WeakMap<ClientSocket, string>();

async function visitor(url: string, visitorId: string = newVisitorId()): Promise<ClientSocket> {
  const socket = await connected(url, await tokenFor(visitorId));
  visitorIdOf.set(socket, visitorId);
  clients.push(socket);
  await ack(socket, 'ping', {}); // fully registered (room joined)
  return socket;
}

/** A new connection for the same visitor (reload / network change), on any node. */
function reconnect(old: ClientSocket, url: string): Promise<ClientSocket> {
  return visitor(url, visitorIdOf.get(old) ?? newVisitorId());
}

async function ack(socket: ClientSocket, event: string, payload: unknown): Promise<AckResult> {
  return (await socket.timeout(3_000).emitWithAck(event, payload)) as AckResult;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Each test uses its own language so leftover tickets of other tests never interfere. */
async function pair(
  lang: SupportedLang,
  opts: { mode?: 'text' | 'video'; autoRequeue?: boolean; ackA?: boolean; ackB?: boolean } = {},
) {
  const join = { mode: opts.mode ?? 'text', lang, autoRequeue: opts.autoRequeue ?? false };
  const a = await visitor(nodeA.url);
  const b = await visitor(nodeB.url);
  const waiting = nextEvent(a, 'queue:waiting');
  expect(await ack(a, 'queue:join', join)).toEqual({ ok: true });
  await waiting;
  const foundA = nextEvent<MatchFound>(a, 'match:found');
  const foundB = nextEvent<MatchFound>(b, 'match:found');
  expect(await ack(b, 'queue:join', join)).toEqual({ ok: true });
  const [matchA, matchB] = await Promise.all([foundA, foundB]);
  if (opts.ackA !== false) {
    expect(await ack(a, 'match:ack', { sessionId: matchA.sessionId })).toEqual({ ok: true });
  }
  if (opts.ackB !== false) {
    expect(await ack(b, 'match:ack', { sessionId: matchB.sessionId })).toEqual({ ok: true });
  }
  return { a, b, matchA, matchB };
}

beforeAll(async () => {
  await appRedis.flushdb();
  nodeA = await startGateway('sa');
  nodeB = await startGateway('sb');
});

afterAll(async () => {
  for (const socket of clients) socket.disconnect();
  await Promise.all([nodeA.gateway.shutdown(), nodeB.gateway.shutdown()]);
  await prisma.$disconnect();
  await appRedis.quit();
});

describe('matching across nodes', () => {
  it('matches two visitors on different nodes symmetrically and relays text both ways', async () => {
    const { a, b, matchA, matchB } = await pair('de');

    expect(matchA.sessionId).toBe(matchB.sessionId);
    expect(matchA.peers).toHaveLength(1);
    expect(matchA.peers[0]?.participantId).toBe(matchB.selfParticipantId);
    expect(matchB.peers[0]?.participantId).toBe(matchA.selfParticipantId);
    const initiators = [matchA.peers[0]?.initiator, matchB.peers[0]?.initiator];
    expect(initiators.filter(Boolean)).toHaveLength(1);
    expect(matchA.peers[0]?.polite).toBe(!matchA.peers[0]?.initiator);
    expect(matchA).toMatchObject({
      mode: 'text',
      topology: 'mesh',
      maxParticipants: 2,
      moderation: { frameIntervalMs: null },
    });
    // Visitor ids never reach the other side.
    expect(JSON.stringify(matchB)).not.toContain(visitorIdOf.get(a));
    expect(JSON.stringify(matchA)).not.toContain(visitorIdOf.get(b));

    const received = nextEvent<ChatMessageOut>(b, 'chat:message');
    const sent = await ack(a, 'chat:message', {
      sessionId: matchA.sessionId,
      text: '  hello there  ',
      clientMsgId: 'c1',
    });
    expect(sent).toMatchObject({ ok: true, data: { id: expect.any(String) as string } });
    expect(await received).toMatchObject({
      sessionId: matchA.sessionId,
      from: matchA.selfParticipantId,
      text: 'hello there',
    });

    const reply = nextEvent<ChatMessageOut>(a, 'chat:message');
    await ack(b, 'chat:message', { sessionId: matchB.sessionId, text: 'hi!', clientMsgId: 'c2' });
    expect((await reply).from).toBe(matchB.selfParticipantId);

    const typing = nextEvent<{ isTyping: boolean }>(b, 'chat:typing');
    await ack(a, 'chat:typing', { sessionId: matchA.sessionId, isTyping: true });
    expect((await typing).isTyping).toBe(true);
    expect(await appRedis.llen(sessionKeys(matchA.sessionId).log)).toBe(2);
  });

  it('prefers shared interests, then falls back to anyone after the interest timeout', async () => {
    const a = await visitor(nodeA.url);
    const b = await visitor(nodeB.url);
    await ack(a, 'queue:join', { mode: 'text', lang: 'fr', interests: ['Music'] });
    const matchB = nextEvent<MatchFound>(b, 'match:found');
    await ack(b, 'queue:join', { mode: 'text', lang: 'fr', interests: ['music', 'games'] });
    expect((await matchB).commonInterests).toEqual(['music']);

    const c = await visitor(nodeA.url);
    const d = await visitor(nodeB.url);
    await ack(c, 'queue:join', { mode: 'text', lang: 'it', interests: ['chess'] });
    const matchD = nextEvent<MatchFound>(d, 'match:found', 5_000);
    await ack(d, 'queue:join', { mode: 'text', lang: 'it' }); // no interests: waits in q:any
    expect((await matchD).commonInterests).toEqual([]); // c promoted after ~300 ms
  });

  it('finds each other across buckets (text:zh has 4) by hopping', async () => {
    for (let round = 0; round < 3; round += 1) {
      const a = await visitor(nodeA.url);
      const b = await visitor(nodeB.url);
      const found = nextEvent<MatchFound>(a, 'match:found', 8_000);
      await ack(a, 'queue:join', { mode: 'text', lang: 'zh' });
      await ack(b, 'queue:join', { mode: 'text', lang: 'zh' });
      const match = await found;
      await ack(a, 'chat:end', { sessionId: match.sessionId });
      a.disconnect();
      b.disconnect();
    }
  });

  it('rejects invalid state transitions', async () => {
    const a = await visitor(nodeA.url);
    expect(await ack(a, 'queue:leave', {})).toMatchObject({ error: { code: 'INVALID_STATE' } });
    await ack(a, 'queue:join', { mode: 'text', lang: 'nl' });
    expect(await ack(a, 'queue:join', { mode: 'text', lang: 'nl' })).toMatchObject({
      error: { code: 'INVALID_STATE' },
    });
    expect(await ack(a, 'queue:leave', {})).toEqual({ ok: true });
  });
});

describe('leaving', () => {
  it('chat:next ends the session for the peer and requeues the skipper', async () => {
    const { a, b, matchA, matchB } = await pair('pl');
    const peerLeft = nextEvent<PeerLeft>(b, 'peer:left');
    const requeued = nextEvent(a, 'queue:waiting');
    expect(await ack(a, 'chat:next', { sessionId: matchA.sessionId })).toEqual({ ok: true });

    expect(await peerLeft).toEqual({
      sessionId: matchA.sessionId,
      participantId: matchA.selfParticipantId,
      reason: 'left',
      sessionEnded: true,
    });
    await requeued;

    // b's old session id is now stale.
    expect(
      await ack(b, 'chat:message', {
        sessionId: matchB.sessionId,
        text: 'hello?',
        clientMsgId: 'x',
      }),
    ).toMatchObject({ ok: false, error: { code: 'NOT_IN_SESSION' } });
    expect(await ack(b, 'chat:end', { sessionId: randomUUID() })).toMatchObject({
      error: { code: 'NOT_IN_SESSION' },
    });

    const job = await nodeA.gateway.sessionLogQueue.getJob(matchA.sessionId);
    expect(job?.data).toMatchObject({ sessionId: matchA.sessionId, mode: 'text' });
    expect(job?.data.participants.map((p) => p.leaveReason).sort()).toEqual(['SKIP', null].sort());
    expect(await appRedis.ttl(sessionKeys(matchA.sessionId).meta)).toBeGreaterThan(3_500);
  });

  it('handles both participants leaving at the same time', async () => {
    const { a, b, matchA } = await pair('tr');
    const results = await Promise.all([
      ack(a, 'chat:end', { sessionId: matchA.sessionId }),
      ack(b, 'chat:end', { sessionId: matchA.sessionId }),
    ]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(await appRedis.hget(sessionKeys(matchA.sessionId).meta, 'state')).toBe('ended');
    expect(await nodeA.gateway.sessionLogQueue.getJob(matchA.sessionId)).toBeDefined();
    expect(await ack(a, 'queue:join', { mode: 'text', lang: 'tr' })).toEqual({ ok: true });
    await ack(a, 'queue:leave', {}); // leave the queue clean for later tests
  });

  it('cancels a waiting ticket on disconnect so nobody is matched with a ghost', async () => {
    const ghost = await visitor(nodeA.url);
    await ack(ghost, 'queue:join', { mode: 'text', lang: 'ar' });
    ghost.disconnect();
    await sleep(200);

    const live = await visitor(nodeB.url);
    const waiting = nextEvent(live, 'queue:waiting');
    await ack(live, 'queue:join', { mode: 'text', lang: 'ar' });
    await waiting;
    await ack(live, 'queue:leave', {});
  });
});

describe('session resilience', () => {
  it('survives a disconnect: resume on the other node returns missed messages', async () => {
    const { a, b, matchA, matchB } = await pair('ru');
    const first = await ack(b, 'chat:message', {
      sessionId: matchB.sessionId,
      text: 'one',
      clientMsgId: '1',
    });
    const firstId = (first.data as { id: string }).id;

    const reconnecting = nextEvent<PeerPresence>(b, 'peer:reconnecting');
    a.disconnect();
    expect(await reconnecting).toEqual({
      sessionId: matchA.sessionId,
      participantId: matchA.selfParticipantId,
    });
    expect(await appRedis.hget(sessionKeys(matchA.sessionId).meta, 'state')).toBe('active');
    await ack(b, 'chat:message', { sessionId: matchB.sessionId, text: 'two', clientMsgId: '2' });

    const resumedEvent = nextEvent<PeerPresence>(b, 'peer:resumed');
    const a2 = await reconnect(a, nodeB.url); // the OTHER node
    const resumed = await ack(a2, 'session:resume', {
      sessionId: matchA.sessionId,
      lastMessageId: firstId,
    });
    expect(resumed.ok).toBe(true);
    const data = resumed.data as SessionResumed;
    expect(data.selfParticipantId).toBe(matchA.selfParticipantId);
    expect(data.peers.map((p) => p.participantId)).toEqual([matchB.selfParticipantId]);
    expect(data.missedMessages.map((m) => m.text)).toEqual(['two']);
    expect((await resumedEvent).participantId).toBe(matchA.selfParticipantId);

    // Without a cursor (client had no messages yet) everything from the others is returned.
    const a3 = await reconnect(a2, nodeA.url);
    const full = await ack(a3, 'session:resume', { sessionId: matchA.sessionId });
    expect((full.data as SessionResumed).missedMessages.map((m) => m.text)).toEqual(['one', 'two']);

    // The session works as before, from the new node.
    const received = nextEvent<ChatMessageOut>(b, 'chat:message');
    await ack(a3, 'chat:message', {
      sessionId: matchA.sessionId,
      text: 'back',
      clientMsgId: '3',
    });
    expect((await received).text).toBe('back');
  });

  it('ends the session when the participant does not come back within the grace period', async () => {
    const { a, b, matchA } = await pair('pt');
    const peerLeft = nextEvent<PeerLeft>(b, 'peer:left', 5_000);
    a.disconnect();
    const started = Date.now();
    expect(await peerLeft).toMatchObject({ reason: 'disconnected', sessionEnded: true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(testConfig.RECONNECT_GRACE_MS - 200);
    const a2 = await reconnect(a, nodeA.url);
    expect(await ack(a2, 'session:resume', { sessionId: matchA.sessionId })).toMatchObject({
      error: { code: 'SESSION_NOT_RESUMABLE' },
    });
  });

  it('keeps sessions alive when a gateway node shuts down; clients resume elsewhere', async () => {
    const nodeC = await startGateway('sc', { drainTimeoutMs: 1_000 });
    const c = await visitor(nodeC.url);
    const b = await visitor(nodeB.url);
    await ack(c, 'queue:join', { mode: 'text', lang: 'hi' });
    const foundB = nextEvent<MatchFound>(b, 'match:found');
    const foundC = nextEvent<MatchFound>(c, 'match:found');
    await ack(b, 'queue:join', { mode: 'text', lang: 'hi' });
    const [matchB, matchC] = await Promise.all([foundB, foundC]);
    await ack(b, 'match:ack', { sessionId: matchB.sessionId });
    await ack(c, 'match:ack', { sessionId: matchC.sessionId });

    let peerLeft = false;
    b.on('peer:left', () => (peerLeft = true));
    const restarting = nextEvent<SystemNotice>(c, 'system:notice');
    const reconnecting = nextEvent<PeerPresence>(b, 'peer:reconnecting');
    const stopping = nodeC.gateway.shutdown();
    expect((await restarting).code).toBe('SERVER_RESTARTING');
    await reconnecting;

    const resumedEvent = nextEvent<PeerPresence>(b, 'peer:resumed');
    const c2 = await reconnect(c, nodeA.url);
    expect((await ack(c2, 'session:resume', { sessionId: matchC.sessionId })).ok).toBe(true);
    await resumedEvent;
    await stopping;
    await sleep(testConfig.RECONNECT_GRACE_MS + 300); // no grace deadline may fire now
    expect(peerLeft).toBe(false);
    expect(await appRedis.hget(sessionKeys(matchC.sessionId).meta, 'state')).toBe('active');
  });

  it('a queue:join after a page reload leaves the old reconnecting session first', async () => {
    const { a, b, matchA } = await pair('es');
    const peerLeft = nextEvent<PeerLeft>(b, 'peer:left');
    const a2 = await reconnect(a, nodeA.url); // old socket is kicked, session → reconnecting
    expect(await ack(a2, 'queue:join', { mode: 'text', lang: 'es' })).toEqual({ ok: true });
    expect(await peerLeft).toMatchObject({ sessionId: matchA.sessionId, sessionEnded: true });
  });

  it('ends a session nobody acked for and requeues the acking peer with priority', async () => {
    const { a, b, matchA, matchB } = await pair('ko', { autoRequeue: true, ackA: false });
    const peerLeft = nextEvent<PeerLeft>(b, 'peer:left', 4_000);
    const requeued = nextEvent(b, 'queue:waiting', 4_000);
    expect(await peerLeft).toMatchObject({
      sessionId: matchB.sessionId,
      participantId: matchA.selfParticipantId,
      reason: 'disconnected',
      sessionEnded: true,
    });
    await requeued; // innocent b is searching again without doing anything

    const job = await nodeA.gateway.sessionLogQueue.getJob(matchA.sessionId);
    const ghost = job?.data.participants.find((p) => p.participantId === matchA.selfParticipantId);
    expect(ghost?.leaveReason).toBe('MATCH_TIMEOUT');
    // The ghost's own stale session is gone.
    expect(
      await ack(a, 'chat:message', { sessionId: matchA.sessionId, text: 'x', clientMsgId: 'x' }),
    ).toMatchObject({ error: { code: 'NOT_IN_SESSION' } });
    await ack(b, 'queue:leave', {});
  });

  it('processes each deadline exactly once with two nodes polling', async () => {
    const pairs = await Promise.all(
      (['ja', 'id', 'en'] as const).map((lang) => pair(lang, { ackA: false, ackB: false })),
    );
    const leftCounts = pairs.map(() => 0);
    pairs.forEach(({ a, b }, index) => {
      for (const socket of [a, b]) {
        socket.on('peer:left', () => (leftCounts[index] = (leftCounts[index] ?? 0) + 1));
      }
    });
    await sleep(testConfig.MATCH_ACK_TIMEOUT_MS + 1_000);

    // Both participants of each pair timed out; whoever was processed first ended the session,
    // the second deadline found them already gone: exactly one peer:left per session.
    expect(leftCounts).toEqual([1, 1, 1]);
    for (const { matchA } of pairs) {
      expect(await appRedis.hget(sessionKeys(matchA.sessionId).meta, 'state')).toBe('ended');
    }
    const remaining = await Promise.all(
      Array.from({ length: testConfig.DEADLINE_SHARDS }, (_, shard) =>
        appRedis.zcard(sessionDeadlinesKey(shard)),
      ),
    );
    expect(remaining.reduce((sum, n) => sum + n, 0)).toBe(0);
  });
});

describe('validation & WebRTC relay', () => {
  it('rejects oversized messages', async () => {
    const { a, matchA } = await pair('nl');
    expect(
      await ack(a, 'chat:message', {
        sessionId: matchA.sessionId,
        text: 'x'.repeat(501),
        clientMsgId: 'big',
      }),
    ).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
  });

  it('relays offers only to an active participant of the same video session', async () => {
    const { a, b, matchA } = await pair('ja', { mode: 'video' });
    const peerId = matchA.peers[0]?.participantId ?? '';

    const offer = nextEvent<RtcDescriptionOut>(b, 'rtc:offer');
    expect(
      await ack(a, 'rtc:offer', { sessionId: matchA.sessionId, to: peerId, sdp: 'v=0 test' }),
    ).toEqual({ ok: true });
    expect(await offer).toEqual({
      sessionId: matchA.sessionId,
      from: matchA.selfParticipantId,
      sdp: 'v=0 test',
    });

    expect(
      await ack(a, 'rtc:ice', {
        sessionId: matchA.sessionId,
        to: 'pNotInSession1',
        candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host' },
      }),
    ).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(
      await ack(a, 'rtc:offer', {
        sessionId: matchA.sessionId,
        to: matchA.selfParticipantId,
        sdp: 'v=0',
      }),
    ).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });

    const text = await pair('ko');
    expect(
      await ack(text.a, 'rtc:offer', {
        sessionId: text.matchA.sessionId,
        to: text.matchA.peers[0]?.participantId,
        sdp: 'v=0',
      }),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_STATE' } });
  });

  it('chat:next with rtc_failed ends a video session as RTC_FAILED and requeues the peer first', async () => {
    const { a, b, matchA, matchB } = await pair('de', { mode: 'video', autoRequeue: true });
    const peerLeft = nextEvent<PeerLeft>(b, 'peer:left');
    const requeuedB = nextEvent(b, 'queue:waiting');
    const requeuedA = nextEvent(a, 'queue:waiting');
    expect(
      await ack(a, 'chat:next', { sessionId: matchA.sessionId, reason: 'rtc_failed' }),
    ).toEqual({ ok: true });
    expect(await peerLeft).toMatchObject({
      sessionId: matchB.sessionId,
      reason: 'disconnected',
      sessionEnded: true,
    });
    // Both search again (the recent-pair rule keeps them apart); b was requeued by the server.
    await Promise.all([requeuedA, requeuedB]);

    const job = await nodeA.gateway.sessionLogQueue.getJob(matchA.sessionId);
    const reporter = job?.data.participants.find(
      (p) => p.participantId === matchA.selfParticipantId,
    );
    expect(reporter?.leaveReason).toBe('RTC_FAILED');
    await Promise.all([ack(a, 'queue:leave', {}), ack(b, 'queue:leave', {})]);
  });

  it('treats rtc_failed in a text session as a normal skip', async () => {
    const { a, b, matchA } = await pair('fr');
    const peerLeft = nextEvent<PeerLeft>(b, 'peer:left');
    expect(
      await ack(a, 'chat:next', { sessionId: matchA.sessionId, reason: 'rtc_failed' }),
    ).toEqual({ ok: true });
    expect(await peerLeft).toMatchObject({ reason: 'left', sessionEnded: true });
    await ack(a, 'queue:leave', {});
    expect(
      await ack(a, 'chat:next', { sessionId: matchA.sessionId, reason: 'other' }),
    ).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
  });

  it('accepts rtc:summary after the session ended, from participants only, once per peer', async () => {
    const { a, b, matchA } = await pair('es', { mode: 'video' });
    const peerLeft = nextEvent(b, 'peer:left');
    expect(await ack(a, 'chat:end', { sessionId: matchA.sessionId })).toEqual({ ok: true });
    await peerLeft;

    const summary = (peer: string | undefined) => ({
      sessionId: matchA.sessionId,
      peer,
      localCandidateType: 'relay',
      remoteCandidateType: 'srflx',
      avgRttMs: 40,
      avgBitrateKbps: 700,
      timeToConnectedMs: 900,
      failed: false,
    });
    const peerId = matchA.peers[0]?.participantId;
    const before = nodeA.gateway.rtcStats.snapshot();
    expect(await ack(a, 'rtc:summary', summary(peerId))).toEqual({ ok: true });
    expect(await ack(a, 'rtc:summary', summary(peerId))).toEqual({ ok: true }); // duplicate
    const after = nodeA.gateway.rtcStats.snapshot();
    expect(after.summaries - before.summaries).toBe(1);
    expect(after.relayed - before.relayed).toBe(1);
    expect(after.timeToConnectedMs.sum - before.timeToConnectedMs.sum).toBe(900);

    expect(await ack(a, 'rtc:summary', summary(matchA.selfParticipantId))).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    });
    const stranger = await visitor(nodeA.url);
    expect(await ack(stranger, 'rtc:summary', summary(peerId))).toMatchObject({
      ok: false,
      error: { code: 'NOT_IN_SESSION' },
    });
  });
});
