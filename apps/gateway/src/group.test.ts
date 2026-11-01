import { randomUUID } from 'node:crypto';

import {
  banVisitorKey,
  matchmakingKeys,
  publishControl,
  sessionKeys,
  trustKey,
} from '@app/redis';
import { createFakeJanus } from '@app/sfu/testing';
import {
  type CallAddRequested,
  type CallSeekCancelled,
  type CallTopology,
  type MatchFound,
  type ParticipantJoined,
  type PeerLeft,
  type SupportedLang,
} from '@app/shared';
import { type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { type Gateway } from './gateway.ts';
import {
  appRedis,
  connected,
  CONTROL_CHANNEL,
  newVisitorId,
  nextEvent,
  prisma,
  startGateway,
  testConfigWith,
  tokenFor,
} from './test/helpers.ts';

// Group calls (Part 12) on one gateway with a fake Janus node: consent, seeking, joiners,
// eligibility, the 4-person limit, leaves and bans.

interface AckResult {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

const ADMIN_SECRET = 'group-test-janus-admin-secret';
const janus = createFakeJanus({ adminSecret: ADMIN_SECRET });
let node: { gateway: Gateway; url: string };
const clients: ClientSocket[] = [];
const idOf = new WeakMap<ClientSocket, string>();

async function visitor(trust?: number): Promise<ClientSocket> {
  const visitorId = newVisitorId();
  if (trust !== undefined) await appRedis.set(trustKey(visitorId), String(trust));
  const socket = await connected(node.url, await tokenFor(visitorId));
  idOf.set(socket, visitorId);
  clients.push(socket);
  await ack(socket, 'ping', {});
  return socket;
}

async function ack(socket: ClientSocket, event: string, payload: unknown): Promise<AckResult> {
  return (await socket.timeout(3_000).emitWithAck(event, payload)) as AckResult;
}

const join = (lang: SupportedLang, allowGroup = false) => ({ mode: 'video', lang, allowGroup });

/** Two strangers in a P2P video call. */
async function call(lang: SupportedLang, trust?: [number, number]) {
  const a = await visitor(trust?.[0]);
  const b = await visitor(trust?.[1]);
  const waiting = nextEvent(a, 'queue:waiting');
  expect(await ack(a, 'queue:join', join(lang))).toEqual({ ok: true });
  await waiting;
  const foundA = nextEvent<MatchFound>(a, 'match:found');
  const foundB = nextEvent<MatchFound>(b, 'match:found');
  expect(await ack(b, 'queue:join', join(lang))).toEqual({ ok: true });
  const [matchA, matchB] = await Promise.all([foundA, foundB]);
  expect(await ack(a, 'match:ack', { sessionId: matchA.sessionId })).toEqual({ ok: true });
  expect(await ack(b, 'match:ack', { sessionId: matchB.sessionId })).toEqual({ ok: true });
  return { a, b, matchA, matchB, sessionId: matchA.sessionId };
}

const meta = (sessionId: string) => appRedis.hgetall(sessionKeys(sessionId).meta);

/** Everyone in `members` agrees to add a person; returns once the call is seeking on Janus. */
async function agree(sessionId: string, members: ClientSocket[]) {
  const asked = members.map((socket) => nextEvent<CallAddRequested>(socket, 'call:addRequested'));
  const [requester, ...others] = members;
  if (requester === undefined) throw new Error('no members');
  expect(await ack(requester, 'call:requestAdd', { sessionId })).toEqual({ ok: true });
  const requests = await Promise.all(asked);
  const requestId = requests[0]?.requestId ?? '';
  const seeking = members.map((socket) => nextEvent(socket, 'call:seeking'));
  const topology = members.map((socket) => nextEvent<CallTopology>(socket, 'call:topology', 5_000));
  for (const socket of others) {
    expect(await ack(socket, 'call:respondAdd', { sessionId, requestId, accept: true })).toEqual({
      ok: true,
    });
  }
  await Promise.all(seeking);
  return { requestId, topology };
}

/** Confirms a P2P → Janus switch for everyone (what clients do once Janus carries the call). */
async function confirmSwitch(sessionId: string, members: ClientSocket[], topology: Promise<CallTopology>[]) {
  const changes = await Promise.all(topology);
  const epoch = changes[0]?.epoch ?? 0;
  for (const socket of members) {
    expect(await ack(socket, 'call:topologyReady', { sessionId, epoch })).toEqual({ ok: true });
  }
  await vi.waitFor(async () => {
    expect(await meta(sessionId)).toMatchObject({ topology: 'sfu', seekState: 'seeking' });
  });
}

/** A visitor who opted in waits for (or finds) a seeking call; resolves on their match. */
async function joiner(lang: SupportedLang, others: ClientSocket[]) {
  const socket = await visitor();
  const found = nextEvent<MatchFound>(socket, 'match:found', 5_000);
  const joined = others.map((other) => nextEvent<ParticipantJoined>(other, 'participant:joined', 5_000));
  expect(await ack(socket, 'queue:join', join(lang, true))).toEqual({ ok: true });
  const match = await found;
  expect(await ack(socket, 'match:ack', { sessionId: match.sessionId })).toEqual({ ok: true });
  return { socket, match, joined: await Promise.all(joined) };
}

beforeAll(async () => {
  await appRedis.flushdb();
  node = await startGateway('group', {
    config: testConfigWith({
      JANUS_NODES: JSON.stringify([
        { id: 'fj-group', wsUrl: 'ws://fj-group.test:8188', adminUrl: 'ws://fj-group.test:7188' },
      ]),
      JANUS_ADMIN_SECRET: ADMIN_SECRET,
      JANUS_TOKEN_SECRET: 'group-test-janus-token-secret',
      GROUP_MIN_TRUST: '50',
      SEEK_PARTICIPANT_TIMEOUT_MS: '1500',
      SFU_UPGRADE_TIMEOUT_MS: '3000',
    }),
    sfuSocketFactory: () => janus.createSocket(),
    addRequestTtlMs: 1_000,
  });
  await vi.waitFor(async () => {
    expect(await node.gateway.sfuRegistry.pickNode()).not.toBeNull();
  });
});

afterAll(async () => {
  for (const socket of clients) socket.disconnect();
  await node.gateway.shutdown();
  await prisma.$disconnect();
  await appRedis.quit();
});

describe('consent', () => {
  it('needs everyone present; one decline ends the round for all', async () => {
    const { a, b, sessionId, matchA } = await call('de');
    const askedA = nextEvent<CallAddRequested>(a, 'call:addRequested');
    const askedB = nextEvent<CallAddRequested>(b, 'call:addRequested');
    expect(await ack(a, 'call:requestAdd', { sessionId })).toEqual({ ok: true });
    const [request] = await Promise.all([askedA, askedB]);
    expect(request).toMatchObject({ sessionId, by: matchA.selfParticipantId });
    // One round at a time.
    expect(await ack(b, 'call:requestAdd', { sessionId })).toMatchObject({
      error: { code: 'INVALID_STATE' },
    });
    const cancelled = [a, b].map((socket) => nextEvent<CallSeekCancelled>(socket, 'call:seekCancelled'));
    expect(
      await ack(b, 'call:respondAdd', { sessionId, requestId: request.requestId, accept: false }),
    ).toEqual({ ok: true });
    expect(await Promise.all(cancelled)).toEqual([
      { sessionId, reason: 'declined' },
      { sessionId, reason: 'declined' },
    ]);
    expect(await meta(sessionId)).toMatchObject({ topology: 'mesh' }); // nothing switched
    expect((await meta(sessionId)).seekState).toBeUndefined();
  });

  it('waits until everyone has joined the call (acked the match)', async () => {
    const a = await visitor();
    const b = await visitor();
    const waiting = nextEvent(a, 'queue:waiting');
    expect(await ack(a, 'queue:join', join('ru'))).toEqual({ ok: true });
    await waiting;
    const foundA = nextEvent<MatchFound>(a, 'match:found');
    const foundB = nextEvent<MatchFound>(b, 'match:found');
    expect(await ack(b, 'queue:join', join('ru'))).toEqual({ ok: true });
    const [match] = await Promise.all([foundA, foundB]);
    const { sessionId } = match;
    expect(await ack(a, 'match:ack', { sessionId })).toEqual({ ok: true });
    // B hasn't acked yet: no round.
    expect(await ack(a, 'call:requestAdd', { sessionId })).toEqual({
      ok: false,
      error: { code: 'INVALID_STATE', message: 'Wait until everyone has joined the call' },
    });
    expect(await ack(b, 'match:ack', { sessionId })).toEqual({ ok: true });
    expect(await ack(a, 'call:requestAdd', { sessionId })).toEqual({ ok: true });
  });

  it('expires when not everyone answers in time', async () => {
    const { a, b, sessionId } = await call('es');
    const expired = [a, b].map((socket) => nextEvent<CallSeekCancelled>(socket, 'call:seekCancelled'));
    expect(await ack(a, 'call:requestAdd', { sessionId })).toEqual({ ok: true });
    expect(await Promise.all(expired)).toEqual([
      { sessionId, reason: 'expired' },
      { sessionId, reason: 'expired' },
    ]);
  });
});

describe('seeking and joining', () => {
  it('switches the P2P call to Janus first, then a waiting and a later opted-in visitor join', async () => {
    const { a, b, sessionId } = await call('fr');
    // C waits (opted in) before the call seeks: the seeking call takes C from the queue.
    const c = await visitor();
    const waitingC = nextEvent(c, 'queue:waiting');
    expect(await ack(c, 'queue:join', join('fr', true))).toEqual({ ok: true });
    await waitingC;
    const keys = matchmakingKeys({ region: 'local', pool: 'normal', mode: 'video', lang: 'fr', bucket: 0 });
    expect(await appRedis.llen(keys.queueAny)).toBe(1);
    const foundC = nextEvent<MatchFound>(c, 'match:found', 8_000);
    const joinedA = nextEvent<ParticipantJoined>(a, 'participant:joined', 8_000);
    const { topology } = await agree(sessionId, [a, b]);
    // Still P2P: nobody joins before the switch is confirmed by everyone.
    expect(await meta(sessionId)).toMatchObject({ topology: 'mesh', seekState: 'pending' });
    await confirmSwitch(sessionId, [a, b], topology).catch(() => undefined);
    const matchC = await foundC;
    expect(matchC).toMatchObject({ sessionId, topology: 'sfu', maxParticipants: 4 });
    expect(matchC.peers).toHaveLength(2);
    expect(matchC.sfu?.token).toBeDefined();
    expect((await joinedA).participantId).toBe(matchC.selfParticipantId);
    expect(await ack(c, 'match:ack', { sessionId })).toEqual({ ok: true });
    const roomId = Number((await meta(sessionId)).sfuRoomId);
    expect(janus.rooms.get(roomId)?.allowed.size).toBe(3);

    // Text reaches everyone, from the new person too.
    const toA = nextEvent<{ text: string }>(a, 'chat:message');
    const toB = nextEvent<{ text: string }>(b, 'chat:message');
    expect(await ack(c, 'chat:message', { sessionId, text: 'hi all', clientMsgId: 'c1' })).toMatchObject({ ok: true });
    expect((await toA).text).toBe('hi all');
    expect((await toB).text).toBe('hi all');

    // A fresh round for the 4th person; this time the joiner comes along later.
    await agree(sessionId, [a, b, c]);
    await vi.waitFor(async () => {
      expect(await meta(sessionId)).toMatchObject({ seekState: 'seeking' }); // already on Janus
    });
    const d = await joiner('fr', [a, b, c]);
    expect(d.match).toMatchObject({ sessionId, topology: 'sfu' });
    expect(d.match.peers).toHaveLength(3);
    expect(janus.rooms.get(roomId)?.allowed.size).toBe(4);
    expect(await meta(sessionId)).toMatchObject({ maxParticipants: '4' });

    // Full: no more rounds; a 5th opted-in visitor stays in the queue.
    expect(await ack(a, 'call:requestAdd', { sessionId })).toMatchObject({
      error: { code: 'INVALID_STATE', message: 'This call is full' },
    });

    // One leaves: the others continue on Janus; the leaver's token is gone and they're kicked.
    const leaverId = d.match.selfParticipantId;
    for (const pid of [leaverId]) janus.join(roomId, pid);
    const left = [a, b, c].map((socket) => nextEvent<PeerLeft>(socket, 'peer:left'));
    expect(await ack(d.socket, 'chat:end', { sessionId })).toEqual({ ok: true });
    expect(await Promise.all(left)).toEqual(
      [a, b, c].map(() => ({ sessionId, participantId: leaverId, reason: 'left', sessionEnded: false })),
    );
    expect(await meta(sessionId)).toMatchObject({ state: 'active', topology: 'sfu' });
    await vi.waitFor(() => {
      expect(janus.rooms.get(roomId)?.allowed.size).toBe(3);
      expect([...(janus.rooms.get(roomId)?.participants.values() ?? [])]).not.toContain(leaverId);
    });
  });

  it('gives up after SEEK_PARTICIPANT_TIMEOUT_MS; the call continues on Janus', async () => {
    const { a, b, sessionId } = await call('it');
    const { topology } = await agree(sessionId, [a, b]);
    const timeouts = [a, b].map((socket) => nextEvent<CallSeekCancelled>(socket, 'call:seekCancelled', 6_000));
    await confirmSwitch(sessionId, [a, b], topology);
    expect(await Promise.all(timeouts)).toEqual([
      { sessionId, reason: 'timeout' },
      { sessionId, reason: 'timeout' },
    ]);
    expect(await meta(sessionId)).toMatchObject({ state: 'active', topology: 'sfu' });
    expect((await meta(sessionId)).seekState).toBeUndefined();
  });
});

describe('Janus failing while a joiner is added', () => {
  it('ends the search for everyone; the joiner is requeued, not stuck', async () => {
    const { a, b, sessionId } = await call('pt');
    const { topology } = await agree(sessionId, [a, b]);
    await confirmSwitch(sessionId, [a, b], topology);
    const cancelled = [a, b].map((socket) =>
      nextEvent<CallSeekCancelled>(socket, 'call:seekCancelled', 5_000),
    );
    const c = await visitor();
    const noMatch = nextEvent<MatchFound>(c, 'match:found', 1_500).catch(() => null);
    janus.setDown(true);
    try {
      expect(await ack(c, 'queue:join', join('pt', true))).toEqual({ ok: true });
      expect(await Promise.all(cancelled)).toEqual([
        { sessionId, reason: 'unavailable' },
        { sessionId, reason: 'unavailable' },
      ]);
    } finally {
      janus.setDown(false);
    }
    expect(await noMatch).toBeNull();
    expect(await meta(sessionId)).toMatchObject({ state: 'active', topology: 'sfu' });
    expect((await meta(sessionId)).seekState).toBeUndefined();
    // C is back at the head of the queue, still searching.
    const keys = matchmakingKeys({ region: 'local', pool: 'normal', mode: 'video', lang: 'pt', bucket: 0 });
    await vi.waitFor(async () => {
      expect(await appRedis.llen(keys.queueAny)).toBe(1);
    });
  });
});

describe('eligibility', () => {
  it('refuses a round when a participant’s trust is too low (without saying whose)', async () => {
    const { a, sessionId } = await call('nl', [80, 20]);
    expect(await ack(a, 'call:requestAdd', { sessionId })).toEqual({
      ok: false,
      error: { code: 'FORBIDDEN', message: 'Adding people isn’t available in this chat' },
    });
  });

  it('never adds visitors without the opt-in, with low trust or in the shadow pool', async () => {
    const { a, b, sessionId } = await call('pl');
    const { topology } = await agree(sessionId, [a, b]);
    await confirmSwitch(sessionId, [a, b], topology);
    const plain = await visitor();
    const lowTrust = await visitor(20);
    const shadow = await visitor();
    await appRedis.set(
      banVisitorKey(idOf.get(shadow) ?? ''),
      JSON.stringify({ banned: true, banId: randomUUID(), type: 'SHADOW', expiresAt: null }),
    );
    const anyMatch = [plain, lowTrust, shadow].map((socket) =>
      nextEvent<MatchFound>(socket, 'match:found', 1_000).catch(() => null),
    );
    expect(await ack(plain, 'queue:join', join('pl', false))).toEqual({ ok: true });
    expect(await ack(lowTrust, 'queue:join', join('pl', true))).toEqual({ ok: true });
    expect(await ack(shadow, 'queue:join', join('pl', true))).toEqual({ ok: true });
    // They may pair up 1:1 with each other, but nobody joins the group call.
    for (const match of await Promise.all(anyMatch)) {
      if (match !== null) expect(match.sessionId).not.toBe(sessionId);
    }
    expect(await meta(sessionId)).toMatchObject({ seekState: 'seeking' });
  });
});

describe('bans in a group call', () => {
  it('remove only the banned participant (kicked from the room); the others continue', async () => {
    const { a, b, sessionId } = await call('tr');
    const { topology } = await agree(sessionId, [a, b]);
    await confirmSwitch(sessionId, [a, b], topology);
    const c = await joiner('tr', [a, b]);
    const roomId = Number((await meta(sessionId)).sfuRoomId);
    const bId = (await ack(b, 'ping', {})).ok ? idOf.get(b) : undefined;
    const bParticipant = c.match.peers.find((peer) => peer.participantId !== c.joined[0]?.participantId);
    for (const peer of c.match.peers) janus.join(roomId, peer.participantId);
    janus.join(roomId, c.match.selfParticipantId);
    const leftA = nextEvent<PeerLeft>(a, 'peer:left');
    await publishControl(
      appRedis,
      {
        type: 'ban_applied',
        originNodeId: 'test',
        banId: randomUUID(),
        banType: 'HARD',
        visitorId: bId ?? '',
        expiresAt: null,
      },
      CONTROL_CHANNEL,
    );
    const left = await leftA;
    expect(left).toMatchObject({ sessionId, reason: 'left', sessionEnded: false });
    expect(await meta(sessionId)).toMatchObject({ state: 'active' });
    await vi.waitFor(() => {
      const displays = [...(janus.rooms.get(roomId)?.participants.values() ?? [])];
      expect(displays).toHaveLength(2);
      expect(displays).not.toContain(left.participantId);
    });
    expect(bParticipant).toBeDefined();
    expect(janus.rooms.get(roomId)?.allowed.size).toBe(2);
  });
});
