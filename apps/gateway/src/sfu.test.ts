import { sessionKeys, SFU_ROOMS_KEY } from '@app/redis';
import { createFakeJanus, type FakeJanus } from '@app/sfu/testing';
import {
  type CallTopology,
  type MatchFound,
  type SessionResumed,
  type SupportedLang,
} from '@app/shared';
import { type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { type Gateway } from './gateway.ts';
import { newParticipantId } from './sessions/store.ts';
import {
  appRedis,
  connected,
  newVisitorId,
  nextEvent,
  prisma,
  startGateway,
  testConfigWith,
  tokenFor,
} from './test/helpers.ts';

// Janus orchestration (Part 11) against fake Janus nodes (`@app/sfu/testing`): the real admin
// client, registry, health loop and Lua scripts run; only the Janus WebSocket is simulated.

interface AckResult {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

const ADMIN_SECRET = 'gateway-test-janus-admin-secret';
const NODES = [
  { id: 'fj-1', wsUrl: 'ws://fj-1.test:8188', adminUrl: 'ws://fj-1.test:7188' },
  { id: 'fj-2', wsUrl: 'ws://fj-2.test:8188', adminUrl: 'ws://fj-2.test:7188' },
];
const fakes = new Map<string, FakeJanus>(
  NODES.map((node) => [node.adminUrl, createFakeJanus({ adminSecret: ADMIN_SECRET })]),
);
const fakeOf = (nodeId: string): FakeJanus => {
  const fake = fakes.get(NODES.find((node) => node.id === nodeId)?.adminUrl ?? '');
  if (fake === undefined) throw new Error(`no fake ${nodeId}`);
  return fake;
};
const sfuConfig = {
  NODE_ENV: 'development', // dev:upgradeToSfu is development-only
  JANUS_NODES: JSON.stringify(NODES),
  JANUS_ADMIN_SECRET: ADMIN_SECRET,
  JANUS_TOKEN_SECRET: 'gateway-test-janus-token-secret',
  SFU_UPGRADE_TIMEOUT_MS: '1000',
};
const socketFactory = (url: string) => {
  const fake = fakes.get(url);
  if (fake === undefined) throw new Error(`no fake Janus at ${url}`);
  return fake.createSocket();
};

let mesh: { gateway: Gateway; url: string };
let forced: { gateway: Gateway; url: string };
const clients: ClientSocket[] = [];
const visitorIdOf = new WeakMap<ClientSocket, string>();

async function visitor(url: string, visitorId: string = newVisitorId()): Promise<ClientSocket> {
  const socket = await connected(url, await tokenFor(visitorId));
  visitorIdOf.set(socket, visitorId);
  clients.push(socket);
  await ack(socket, 'ping', {});
  return socket;
}

async function ack(socket: ClientSocket, event: string, payload: unknown): Promise<AckResult> {
  return (await socket.timeout(3_000).emitWithAck(event, payload)) as AckResult;
}

async function pair(url: string, lang: SupportedLang, mode: 'text' | 'video' = 'video') {
  const join = { mode, lang };
  const a = await visitor(url);
  const b = await visitor(url);
  const waiting = nextEvent(a, 'queue:waiting');
  expect(await ack(a, 'queue:join', join)).toEqual({ ok: true });
  await waiting;
  const foundA = nextEvent<MatchFound>(a, 'match:found');
  const foundB = nextEvent<MatchFound>(b, 'match:found');
  expect(await ack(b, 'queue:join', join)).toEqual({ ok: true });
  const [matchA, matchB] = await Promise.all([foundA, foundB]);
  expect(await ack(a, 'match:ack', { sessionId: matchA.sessionId })).toEqual({ ok: true });
  expect(await ack(b, 'match:ack', { sessionId: matchB.sessionId })).toEqual({ ok: true });
  return { a, b, matchA, matchB, sessionId: matchA.sessionId };
}

const meta = (sessionId: string) => appRedis.hgetall(sessionKeys(sessionId).meta);
const offer = (sessionId: string, to: string) => ({ sessionId, to, sdp: 'v=0' });

async function waitForHealthy(gateway: Gateway): Promise<void> {
  await vi.waitFor(async () => {
    const health = await gateway.sfuRegistry.health();
    expect(
      [...health.values()].filter((entry) => entry.healthy && entry.failures === 0),
    ).toHaveLength(2);
  });
}

beforeAll(async () => {
  await appRedis.flushdb();
  mesh = await startGateway('sfu-mesh', {
    config: testConfigWith(sfuConfig),
    sfuSocketFactory: socketFactory,
  });
  forced = await startGateway('sfu-forced', {
    config: testConfigWith({ ...sfuConfig, DEV_FORCE_SFU: 'true' }),
    sfuSocketFactory: socketFactory,
  });
  await waitForHealthy(mesh.gateway);
});

afterAll(async () => {
  for (const socket of clients) socket.disconnect();
  await Promise.all([mesh.gateway.shutdown(), forced.gateway.shutdown()]);
  await prisma.$disconnect();
  await appRedis.quit();
});

describe('DEV_FORCE_SFU', () => {
  it('starts video calls on Janus with a token per participant; text stays P2P', async () => {
    const { matchA, matchB, a, sessionId } = await pair(forced.url, 'en');
    expect(matchA.topology).toBe('sfu');
    expect(matchA.sfu).toMatchObject({ roomId: matchB.sfu?.roomId, epoch: 1 });
    expect(matchA.sfu?.token).not.toBe(matchB.sfu?.token);
    const nodeId = (await meta(sessionId)).sfuNodeId ?? '';
    const room = fakeOf(nodeId).rooms.get(matchA.sfu?.roomId ?? 0);
    expect(room?.allowed).toEqual(new Set([matchA.sfu?.token, matchB.sfu?.token]));
    expect(room?.publishers).toBe(4);
    expect(await appRedis.hexists(SFU_ROOMS_KEY, `${nodeId}:${String(matchA.sfu?.roomId)}`)).toBe(
      1,
    );

    // No P2P signaling once the call runs on Janus.
    expect(await ack(a, 'rtc:offer', offer(sessionId, matchB.selfParticipantId))).toMatchObject({
      ok: false,
      error: { code: 'INVALID_STATE' },
    });

    const text = await pair(forced.url, 'es', 'text');
    expect(text.matchA.topology).toBe('mesh');
    expect(text.matchA.sfu).toBeUndefined();
  });

  it('hands out the current room on resume and fresh tokens for long calls', async () => {
    const { a, matchA, sessionId } = await pair(forced.url, 'fr');
    a.disconnect();
    const back = await visitor(forced.url, visitorIdOf.get(a));
    const resumed = await ack(back, 'session:resume', { sessionId });
    expect(resumed.ok).toBe(true);
    expect((resumed.data as SessionResumed).sfu).toEqual(matchA.sfu);

    const fresh = await ack(back, 'call:sfuToken', { sessionId, epoch: 1 });
    expect(fresh).toMatchObject({ ok: true, data: { token: expect.any(String) as string } });
    expect((fresh.data as { token: string }).token).not.toBe(matchA.sfu?.token);
    expect(await ack(back, 'call:sfuToken', { sessionId, epoch: 2 })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_STATE' },
    });
  });

  it('destroys the room when the call ends', async () => {
    const { b, matchA, sessionId } = await pair(forced.url, 'de');
    const nodeId = (await meta(sessionId)).sfuNodeId ?? '';
    const roomId = matchA.sfu?.roomId ?? 0;
    expect(fakeOf(nodeId).rooms.has(roomId)).toBe(true);
    expect(await ack(b, 'chat:end', { sessionId })).toEqual({ ok: true });
    await vi.waitFor(() => {
      expect(fakeOf(nodeId).rooms.has(roomId)).toBe(false);
    });
    await vi.waitFor(async () => {
      expect(await appRedis.hexists(SFU_ROOMS_KEY, `${nodeId}:${String(roomId)}`)).toBe(0);
    });
  });
});

describe('mesh → sfu upgrade', () => {
  it('completes once every participant confirmed; P2P relay stops afterwards', async () => {
    const { a, b, matchA, matchB, sessionId } = await pair(mesh.url, 'it');
    expect(matchA.topology).toBe('mesh');
    const topologyA = nextEvent<CallTopology>(a, 'call:topology');
    const topologyB = nextEvent<CallTopology>(b, 'call:topology');
    expect(await ack(a, 'dev:upgradeToSfu', { sessionId })).toEqual({ ok: true });
    const [toA, toB] = await Promise.all([topologyA, topologyB]);
    expect(toA).toMatchObject({ sessionId, topology: 'sfu', epoch: 1 });
    if (toA.topology !== 'sfu' || toB.topology !== 'sfu') throw new Error('expected sfu');
    expect(toA.sfu.roomId).toBe(toB.sfu.roomId);
    expect(toA.sfu.token).not.toBe(toB.sfu.token);
    expect(await meta(sessionId)).toMatchObject({ topology: 'mesh', topologyState: 'upgrading' });

    // Make-before-break: P2P signaling still works while the switch is in progress.
    const relayed = nextEvent(b, 'rtc:offer');
    expect(await ack(a, 'rtc:offer', offer(sessionId, matchB.selfParticipantId))).toEqual({
      ok: true,
    });
    await relayed;

    expect(await ack(a, 'call:topologyReady', { sessionId, epoch: 1 })).toEqual({ ok: true });
    expect(await meta(sessionId)).toMatchObject({ topologyState: 'upgrading' });
    expect(await ack(b, 'call:topologyReady', { sessionId, epoch: 1 })).toEqual({ ok: true });
    expect(await meta(sessionId)).toMatchObject({ topology: 'sfu', topologyState: 'stable' });
    expect(await ack(a, 'rtc:offer', offer(sessionId, matchB.selfParticipantId))).toMatchObject({
      ok: false,
      error: { code: 'INVALID_STATE' },
    });
    // Never back: a second upgrade request is refused.
    expect(await ack(b, 'dev:upgradeToSfu', { sessionId })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_STATE' },
    });
    expect(
      (await mesh.gateway.metrics.registry.getSingleMetricAsString('sfu_upgrades_total')).includes(
        'outcome="succeeded"',
      ),
    ).toBe(true);
  });

  it('rolls back after the timeout: room destroyed, call:topology mesh, P2P keeps working', async () => {
    const { a, b, matchB, sessionId } = await pair(mesh.url, 'pt');
    const announced = nextEvent<CallTopology>(a, 'call:topology');
    expect(await ack(a, 'dev:upgradeToSfu', { sessionId })).toEqual({ ok: true });
    const upgrade = await announced;
    if (upgrade.topology !== 'sfu') throw new Error('expected sfu');
    const nodeId = (await meta(sessionId)).sfuNodeId ?? '';
    expect(fakeOf(nodeId).rooms.has(upgrade.sfu.roomId)).toBe(true);
    expect(await ack(a, 'call:topologyReady', { sessionId, epoch: 1 })).toEqual({ ok: true });

    const rollbackA = nextEvent<CallTopology>(a, 'call:topology', 5_000);
    const rollbackB = nextEvent<CallTopology>(b, 'call:topology', 5_000);
    const [backA] = await Promise.all([rollbackA, rollbackB]); // B never confirmed (1 s timeout)
    expect(backA).toEqual({ sessionId, topology: 'mesh', epoch: 1, reason: 'timeout' });
    expect(fakeOf(nodeId).rooms.has(upgrade.sfu.roomId)).toBe(false);
    expect(await meta(sessionId)).toMatchObject({ topology: 'mesh', topologyState: 'stable' });
    const relayed = nextEvent(b, 'rtc:offer');
    expect(await ack(a, 'rtc:offer', offer(sessionId, matchB.selfParticipantId))).toEqual({
      ok: true,
    });
    await relayed;
    // A late confirmation for the rolled-back epoch changes nothing.
    expect(await ack(b, 'call:topologyReady', { sessionId, epoch: 1 })).toEqual({ ok: true });
    expect(await meta(sessionId)).toMatchObject({ topology: 'mesh' });
  });

  it('runs one upgrade for concurrent requests', async () => {
    const { a, b, sessionId } = await pair(mesh.url, 'nl');
    const creates = () => [...fakes.values()].flatMap((fake) => fake.requestsOf('create')).length;
    const before = creates();
    const answers = await Promise.all(
      [a, b, a, b, a].map((socket) => ack(socket, 'dev:upgradeToSfu', { sessionId })),
    );
    expect(answers.filter((answer) => answer.ok)).toHaveLength(1);
    expect(answers.filter((answer) => answer.error?.code === 'INVALID_STATE')).toHaveLength(4);
    expect(creates() - before).toBe(1);
  });

  it('rolls back at once when no Janus node is available', async () => {
    const { a, b, matchB, sessionId } = await pair(mesh.url, 'pl');
    for (const fake of fakes.values()) fake.setDown(true);
    await vi.waitFor(async () => {
      expect(await mesh.gateway.sfuRegistry.pickNode()).toBeNull();
    });
    expect(await ack(a, 'dev:upgradeToSfu', { sessionId })).toMatchObject({
      ok: false,
      error: { code: 'SERVICE_UNAVAILABLE' },
    });
    expect(await meta(sessionId)).toMatchObject({ topology: 'mesh', topologyState: 'stable' });
    const relayed = nextEvent(b, 'rtc:offer');
    expect(await ack(a, 'rtc:offer', offer(sessionId, matchB.selfParticipantId))).toEqual({
      ok: true,
    });
    await relayed;
    for (const fake of fakes.values()) fake.setDown(false);
    await waitForHealthy(mesh.gateway);
  });

  it('is a development-only event', async () => {
    // Started only here: a gateway without Janus nodes would also claim upgrade deadlines.
    const plain = await startGateway('sfu-plain'); // NODE_ENV=test
    try {
      const socket = await visitor(plain.url);
      expect(
        await ack(socket, 'dev:upgradeToSfu', { sessionId: crypto.randomUUID() }),
      ).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION_FAILED', message: 'Unknown event' },
      });
      socket.disconnect();
    } finally {
      await plain.gateway.shutdown();
    }
  });
});

describe('participants leaving an SFU call', () => {
  it('removes the leaver from the allowed list and kicks them; the others stay', async () => {
    const { store, sfu } = mesh.gateway;
    const sessionId = crypto.randomUUID();
    const ids = [newParticipantId(), newParticipantId(), newParticipantId()];
    const opened = await sfu.openRoom(sessionId, ids);
    if (opened === null) throw new Error('no room');
    const fake = fakeOf(opened.placement.nodeId);
    await store.createSession({
      sessionId,
      mode: 'video',
      lang: 'en',
      commonInterests: [],
      initiator: ids[0] ?? '',
      participants: ids.map((participantId) => ({
        participantId,
        visitorId: newVisitorId(),
        pool: 'normal',
        interests: [],
        autoRequeue: false,
        frames: { tier: 'high', frameIntervalMs: null, maxFrames: null },
        sfuToken: opened.tokens.get(participantId) ?? '',
      })),
      now: Date.now(),
      sfu: opened.placement,
    });
    for (const id of ids) fake.join(opened.placement.roomId, id);
    const leaver = ids[2] ?? '';
    const outcome = await store.leave(sessionId, leaver, 'SKIP', Date.now());
    expect(outcome).toMatchObject({ status: 'left', ended: false });
    const context = await store.context(sessionId);
    if (context === null) throw new Error('no context');
    await sfu.afterLeave(context, leaver, false);
    const room = fake.rooms.get(opened.placement.roomId);
    expect(room?.allowed.has(opened.tokens.get(leaver) ?? '')).toBe(false);
    expect(room?.allowed.size).toBe(2);
    expect([...(room?.participants.values() ?? [])].sort()).toEqual([ids[0], ids[1]].sort());
  });
});

describe('failover', () => {
  it('moves a call to another node when its node goes down (epoch + 1)', async () => {
    const { a, b, matchA, sessionId } = await pair(forced.url, 'ja');
    const from = (await meta(sessionId)).sfuNodeId ?? '';
    const movedA = nextEvent<CallTopology>(a, 'call:topology', 8_000);
    const movedB = nextEvent<CallTopology>(b, 'call:topology', 8_000);
    fakeOf(from).setDown(true);
    const [toA, toB] = await Promise.all([movedA, movedB]);
    if (toA.topology !== 'sfu' || toB.topology !== 'sfu') throw new Error('expected sfu');
    const target = NODES.find((node) => node.id !== from);
    expect(toA).toMatchObject({ sessionId, epoch: 2, sfu: { wsUrl: target?.wsUrl } });
    expect(toA.sfu.roomId).toBe(toB.sfu.roomId);
    expect(toA.sfu.roomId).not.toBe(matchA.sfu?.roomId);
    expect(await meta(sessionId)).toMatchObject({ sfuNodeId: target?.id, topologyEpoch: '2' });
    expect(fakeOf(target?.id ?? '').rooms.get(toA.sfu.roomId)?.allowed.size).toBe(2);
    expect(await appRedis.hexists(SFU_ROOMS_KEY, `${from}:${String(matchA.sfu?.roomId)}`)).toBe(0);
    // The new room's epoch is confirmed like an upgrade's, without changing the topology.
    expect(await ack(a, 'call:topologyReady', { sessionId, epoch: 2 })).toEqual({ ok: true });
    expect(await ack(b, 'call:topologyReady', { sessionId, epoch: 2 })).toEqual({ ok: true });
    expect(await meta(sessionId)).toMatchObject({ topology: 'sfu', topologyState: 'stable' });
    fakeOf(from).setDown(false);
    await waitForHealthy(forced.gateway);
  });
});
