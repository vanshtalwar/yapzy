import { randomUUID } from 'node:crypto';

import { sessionKeys, visitorTicketKey } from '@app/redis';
import {
  type ChatMessageOut,
  type MatchFound,
  type PeerLeft,
  type RtcDescriptionOut,
  type SupportedLang,
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

async function visitor(url: string): Promise<ClientSocket> {
  const visitorId = newVisitorId();
  const socket = await connected(url, await tokenFor(visitorId));
  visitorIdOf.set(socket, visitorId);
  clients.push(socket);
  await ack(socket, 'ping', {}); // fully registered (room joined)
  return socket;
}

async function ack(socket: ClientSocket, event: string, payload: unknown): Promise<AckResult> {
  return (await socket.timeout(3_000).emitWithAck(event, payload)) as AckResult;
}

/** Each test uses its own language so leftover tickets of other tests never interfere. */
async function pair(lang: SupportedLang, mode: 'text' | 'video' = 'text') {
  const a = await visitor(nodeA.url);
  const b = await visitor(nodeB.url);
  const waiting = nextEvent(a, 'queue:waiting');
  expect(await ack(a, 'queue:join', { mode, lang })).toEqual({ ok: true });
  await waiting;
  const matchA = nextEvent<MatchFound>(a, 'match:found');
  const matchB = nextEvent<MatchFound>(b, 'match:found');
  expect(await ack(b, 'queue:join', { mode, lang })).toEqual({ ok: true });
  return { a, b, matchA: await matchA, matchB: await matchB };
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
    expect(matchA).toMatchObject({ mode: 'text', topology: 'mesh', maxParticipants: 2 });
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
    const message = await received;
    expect(message).toMatchObject({
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

  it('rejects invalid state transitions', async () => {
    const a = await visitor(nodeA.url);
    expect(await ack(a, 'queue:leave', {})).toMatchObject({ error: { code: 'INVALID_STATE' } });
    await ack(a, 'queue:join', { mode: 'text', lang: 'nl' });
    expect(await ack(a, 'queue:join', { mode: 'text', lang: 'nl' })).toMatchObject({
      error: { code: 'INVALID_STATE' },
    });
    expect(await ack(a, 'queue:leave', {})).toEqual({ ok: true });
    expect(await appRedis.exists(visitorTicketKey(newVisitorId()))).toBe(0);
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

    // b's old session id is now stale; b is idle and may queue again.
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
    // Both are idle again.
    expect(await ack(a, 'queue:join', { mode: 'text', lang: 'tr' })).toEqual({ ok: true });
  });

  it('ends the session when a participant disconnects', async () => {
    const { a, b, matchA } = await pair('ru');
    const peerLeft = nextEvent<PeerLeft>(b, 'peer:left');
    a.disconnect();
    expect(await peerLeft).toMatchObject({ reason: 'disconnected', sessionEnded: true });
    expect(matchA.sessionId).toBe((await peerLeft).sessionId);
  });

  it('cancels a waiting ticket on disconnect so nobody is matched with a ghost', async () => {
    const ghost = await visitor(nodeA.url);
    await ack(ghost, 'queue:join', { mode: 'text', lang: 'ar' });
    ghost.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 200));

    const live = await visitor(nodeB.url);
    const waiting = nextEvent(live, 'queue:waiting');
    await ack(live, 'queue:join', { mode: 'text', lang: 'ar' });
    await waiting;
  });

  it('ends local sessions with a server-restart reason when a node shuts down', async () => {
    const nodeC = await startGateway('sc');
    const c = await visitor(nodeC.url);
    const b = await visitor(nodeB.url);
    await ack(c, 'queue:join', { mode: 'text', lang: 'hi' });
    const match = nextEvent<MatchFound>(b, 'match:found');
    await ack(b, 'queue:join', { mode: 'text', lang: 'hi' });
    await match;

    const peerLeft = nextEvent<PeerLeft>(b, 'peer:left');
    const stopping = nodeC.gateway.shutdown();
    expect(await peerLeft).toMatchObject({ reason: 'disconnected', sessionEnded: true });
    c.disconnect();
    await stopping;
  });
});

describe('validation & WebRTC relay', () => {
  it('rejects oversized messages', async () => {
    const { a, matchA } = await pair('id');
    expect(
      await ack(a, 'chat:message', {
        sessionId: matchA.sessionId,
        text: 'x'.repeat(501),
        clientMsgId: 'big',
      }),
    ).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
  });

  it('relays offers only to an active participant of the same video session', async () => {
    const { a, b, matchA } = await pair('ja', 'video');
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
});
