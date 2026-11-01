import { randomUUID } from 'node:crypto';

import { createEnv, janusTestEnv } from '@app/env';
import { SFU_NODES_KEY, SFU_ROOMS_KEY } from '@app/redis';
import { createTestRedis } from '@app/redis/testing';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createJanusAdminClient, JanusAdminError } from './admin-client.ts';
import { startSfuHealthLoop } from './health.ts';
import { createSfuRegistry, type JanusNode } from './registry.ts';
import { type BookedRoom, createRoomBook, sweepOrphanRooms } from './rooms.ts';
import { createFakeJanus } from './testing.ts';
import { janusTokenExpiry, signJanusToken, VIDEOROOM_PLUGIN } from './tokens.ts';
import { createVideoRoomAdmin, newRoomId, roomSecret, VIDEOROOM_ERRORS } from './videoroom.ts';

// Integration tests against the development Janus container (`pnpm infra:up`) and Redis DB 8.
const env = createEnv(janusTestEnv, { service: 'sfu-tests' });
function firstNode(): JanusNode {
  const node = env.JANUS_NODES[0];
  if (node === undefined) throw new Error('JANUS_NODES must list the dev Janus node for tests');
  return node;
}
const janus = firstNode();
const redis = createTestRedis('sfu-tests', { dbIndex: 8 });
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

const adminClient = createJanusAdminClient({ url: janus.adminUrl, secret: env.JANUS_ADMIN_SECRET });
const admin = createVideoRoomAdmin(adminClient, env.JANUS_ADMIN_SECRET);
const created: number[] = [];

async function createRoom(allowed: string[]): Promise<number> {
  const roomId = newRoomId();
  created.push(roomId);
  await admin.createRoom({
    roomId,
    secret: roomSecret(env.JANUS_ADMIN_SECRET, janus.id, roomId),
    allowed,
    bitrate: 600_000,
  });
  return roomId;
}

const token = (expiresInSeconds = 600) =>
  signJanusToken({
    secret: env.JANUS_TOKEN_SECRET,
    expiresAt: Math.floor(Date.now() / 1000) + expiresInSeconds,
  });

/** Minimal Janus API client (what a browser does): session → attach → join. */
async function janusApi(apiToken: string | undefined) {
  const ws = new WebSocket(janus.wsUrl, 'janus-protocol');
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  const waiting = new Map<string, (message: Record<string, unknown>) => void>();
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as Record<string, unknown>;
    if (message.janus === 'ack') return; // async requests answer with an event later
    const resolve = waiting.get(String(message.transaction));
    waiting.delete(String(message.transaction));
    resolve?.(message);
  };
  const send = (body: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const transaction = randomUUID();
      waiting.set(transaction, resolve);
      ws.send(JSON.stringify({ ...body, transaction, ...(apiToken ? { token: apiToken } : {}) }));
    });
  return {
    send,
    async join(roomId: number, joinToken: string | undefined, display: string) {
      const session = await send({ janus: 'create' });
      if (session.janus !== 'success') return session;
      const sessionId = (session.data as { id: number }).id;
      const handle = await send({
        janus: 'attach',
        session_id: sessionId,
        plugin: VIDEOROOM_PLUGIN,
      });
      if (handle.janus !== 'success') return handle;
      return send({
        janus: 'message',
        session_id: sessionId,
        handle_id: (handle.data as { id: number }).id,
        body: {
          request: 'join',
          ptype: 'publisher',
          room: roomId,
          display,
          ...(joinToken ? { token: joinToken } : {}),
        },
      });
    },
    close: () => {
      ws.close();
    },
  };
}

const pluginData = (event: Record<string, unknown>) =>
  (event.plugindata as { data: Record<string, unknown> } | undefined)?.data;

afterAll(async () => {
  for (const roomId of created) {
    await admin
      .destroyRoom(roomId, roomSecret(env.JANUS_ADMIN_SECRET, janus.id, roomId))
      .catch(() => undefined);
  }
  adminClient.close();
  await redis.flushdb();
  await redis.quit();
});

beforeEach(async () => {
  await redis.flushdb();
});

describe('signed tokens', () => {
  it('sign "<expiry>,janus,janus.plugin.videoroom,n=<nonce>:<HMAC-SHA256>" and verify', () => {
    const value = signJanusToken({
      secret: 'secret-secret-secret',
      expiresAt: 1_900_000_000,
      nonce: 'abc',
    });
    expect(value).toMatch(/^1900000000,janus,janus\.plugin\.videoroom,n=abc:[A-Za-z0-9+/]+=*$/);
    expect(janusTokenExpiry(value, 'secret-secret-secret')).toBe(1_900_000_000);
    expect(janusTokenExpiry(value, 'another-secret-xyz')).toBeNull();
    expect(token()).not.toBe(token()); // random nonce: one allowed-list entry per participant
  });
});

describe('Janus Admin API (real container)', () => {
  it('rejects a wrong admin secret', async () => {
    const wrong = createJanusAdminClient({ url: janus.adminUrl, secret: 'not-the-admin-secret' });
    await expect(
      wrong.messagePlugin(VIDEOROOM_PLUGIN, { request: 'list', admin_key: env.JANUS_ADMIN_SECRET }),
    ).rejects.toMatchObject({ name: 'JanusAdminError', code: 403 });
    wrong.close();
  });

  it('creates and destroys rooms; only the admin key can create', async () => {
    const roomId = await createRoom([]);
    expect(await admin.listRooms()).toContain(roomId);
    const secret = roomSecret(env.JANUS_ADMIN_SECRET, janus.id, roomId);
    expect(await admin.destroyRoom(roomId, secret)).toBe(true);
    expect(await admin.listRooms()).not.toContain(roomId);
    expect(await admin.destroyRoom(roomId, secret)).toBe(false); // already gone

    const noKey = createVideoRoomAdmin(adminClient, 'wrong-admin-key-123456');
    await expect(
      noKey.createRoom({ roomId: newRoomId(), secret: 'x', allowed: [], bitrate: 1 }),
    ).rejects.toBeInstanceOf(JanusAdminError);
  });

  it('lets only a valid, unexpired token of that room join; revoked tokens cannot rejoin', async () => {
    const tokenA = token();
    const tokenB = token();
    const roomA = await createRoom([tokenA]);
    const roomB = await createRoom([tokenB]);

    const anonymous = await janusApi(undefined);
    expect(await anonymous.send({ janus: 'create' })).toMatchObject({
      janus: 'error',
      error: { code: 403 },
    });
    anonymous.close();

    const expired = token(-60);
    const late = await janusApi(expired);
    expect(await late.send({ janus: 'create' })).toMatchObject({
      janus: 'error',
      error: { code: 403 },
    });
    late.close();

    const forged = await janusApi(`${tokenA.split(':')[0] ?? ''}:AAAA`);
    expect(await forged.send({ janus: 'create' })).toMatchObject({ janus: 'error' });
    forged.close();

    const client = await janusApi(tokenA);
    const otherRoom = await client.join(roomB, tokenA, 'pAAAAAAAAAAA');
    expect(pluginData(otherRoom)).toMatchObject({ error_code: VIDEOROOM_ERRORS.UNAUTHORIZED });
    const noJoinToken = await client.join(roomA, undefined, 'pAAAAAAAAAAA');
    expect(pluginData(noJoinToken)).toMatchObject({ error_code: VIDEOROOM_ERRORS.UNAUTHORIZED });
    const joined = await client.join(roomA, tokenA, 'pAAAAAAAAAAA');
    expect(pluginData(joined)).toMatchObject({ videoroom: 'joined', room: roomA });

    // Kick = remove from the allowed list, then kick the publisher (by its display).
    const secret = roomSecret(env.JANUS_ADMIN_SECRET, janus.id, roomA);
    const [member] = await admin.listParticipants(roomA);
    expect(member).toMatchObject({ display: 'pAAAAAAAAAAA' });
    await admin.allowTokens(roomA, secret, 'remove', [tokenA]);
    await admin.kick(roomA, secret, member?.id ?? 0);
    expect(await admin.listParticipants(roomA)).toEqual([]);
    await admin.kick(roomA, secret, member?.id ?? 0); // already gone: fine
    const rejoin = await client.join(roomA, tokenA, 'pAAAAAAAAAAA');
    expect(pluginData(rejoin)).toMatchObject({ error_code: VIDEOROOM_ERRORS.UNAUTHORIZED });
    client.close();
  });
});

function fakeNodes(count: number) {
  const fakes = Array.from({ length: count }, () =>
    createFakeJanus({ adminSecret: env.JANUS_ADMIN_SECRET }),
  );
  const nodes: JanusNode[] = fakes.map((_, index) => ({
    id: `fake-${String(index + 1)}`,
    wsUrl: `ws://fake-${String(index + 1)}:8188`,
    adminUrl: `ws://fake-${String(index + 1)}:7188`,
  }));
  const registry = createSfuRegistry({
    redis,
    nodes,
    adminSecret: env.JANUS_ADMIN_SECRET,
    requestTimeoutMs: 500,
    createSocket: (url) => {
      const index = nodes.findIndex((node) => node.adminUrl === url);
      const fake = fakes[index];
      if (fake === undefined) throw new Error(`no fake for ${url}`);
      return fake.createSocket();
    },
  });
  return { fakes, nodes, registry };
}

describe('placement', () => {
  it('picks the healthy node with the fewest rooms; skips failing, stale and excluded ones', async () => {
    const { registry } = fakeNodes(4);
    const fresh = Date.now();
    const entry = (rooms: number, healthy = true, failures = 0, at = fresh) => ({
      wsUrl: 'ws://x:8188',
      adminUrl: 'ws://x:7188',
      healthy,
      rooms,
      failures,
      lastCheckedAt: at,
    });
    await registry.saveHealth('fake-1', entry(5));
    await registry.saveHealth('fake-2', entry(2));
    await registry.saveHealth('fake-3', entry(0, false, 2));
    await registry.saveHealth('fake-4', entry(1, true, 0, fresh - 60_000)); // stale
    expect((await registry.pickNode())?.id).toBe('fake-2');
    expect((await registry.pickNode({ exclude: 'fake-2' }))?.id).toBe('fake-1');
    await registry.saveHealth('fake-1', entry(5, true, 1)); // one failed check: avoid it
    expect(await registry.pickNode({ exclude: 'fake-2' })).toBeNull();
    registry.close();
  });
});

describe('health checks', () => {
  it('marks a stopped node unhealthy (real Janus stays healthy)', async () => {
    const registry = createSfuRegistry({
      redis,
      nodes: [
        janus,
        { id: 'stopped', wsUrl: 'ws://127.0.0.1:7999', adminUrl: 'ws://127.0.0.1:7999' },
      ],
      adminSecret: env.JANUS_ADMIN_SECRET,
      requestTimeoutMs: 1_000,
    });
    const up = await registry.check(janus.id, undefined);
    expect(up.health).toMatchObject({ healthy: true, failures: 0 });
    expect(Array.isArray(up.roomIds)).toBe(true);
    const down = await registry.check('stopped', undefined);
    expect(down.health).toMatchObject({ healthy: false, failures: 1 });
    expect(down.roomIds).toBeNull();
    registry.close();
  });

  it('leader loop: a node that stops answering turns unhealthy and its rooms are handed over', async () => {
    const { fakes, registry } = fakeNodes(2);
    const book = createRoomBook(redis);
    const sessionId = randomUUID();
    await book.add('fake-1', 42, { sessionId, createdAt: Date.now() });
    const lost: BookedRoom[][] = [];
    const transitions: [string, boolean][] = [];
    const loop = startSfuHealthLoop({
      redis,
      registry,
      book,
      owner: 'gw-test',
      intervalMs: 100,
      failingIntervalMs: 50,
      onRoomsLost: (rooms) => {
        lost.push(rooms);
        return Promise.resolve();
      },
      onTransition: (nodeId, healthy) => transitions.push([nodeId, healthy]),
      logger,
    });
    await vi.waitFor(async () => {
      expect((await registry.health()).get('fake-2')?.healthy).toBe(true);
    });
    expect(loop.isLeader()).toBe(true);
    expect(lost).toEqual([]); // booked room on a healthy node, still inside the grace period

    fakes[0]?.setDown(true);
    await vi.waitFor(async () => {
      expect((await registry.health()).get('fake-1')).toMatchObject({ healthy: false });
    });
    await vi.waitFor(() => {
      expect(lost.at(-1)).toEqual([
        expect.objectContaining({ nodeId: 'fake-1', roomId: 42, sessionId }),
      ]);
    });
    expect(transitions).toContainEqual(['fake-1', false]);
    await loop.stop();
    expect(await redis.exists('lock:sfu:health')).toBe(0); // handed over on stop
    registry.close();
  });
});

describe('orphan rooms', () => {
  // Fake node: a sweep on the shared dev Janus would also destroy rooms of a running dev call.
  it('destroys rooms nobody booked and booked rooms whose session is over; keeps live ones', async () => {
    const { fakes, registry } = fakeNodes(1);
    const fake = fakes[0];
    if (fake === undefined) throw new Error('no fake');
    await registry.saveHealth('fake-1', (await registry.check('fake-1', undefined)).health);
    const book = createRoomBook(redis);
    const old = Date.now() - 60_000;
    const make = async (roomId: number) => {
      await registry.admin('fake-1').createRoom({
        roomId,
        secret: roomSecret(env.JANUS_ADMIN_SECRET, 'fake-1', roomId),
        allowed: [],
        bitrate: 600_000,
      });
    };

    await make(1); // never booked: orphan
    await make(2); // booked, session over
    await make(3); // booked, live
    await make(4); // booked just now (its session may not exist yet)
    const endedSession = randomUUID();
    await book.add('fake-1', 2, { sessionId: endedSession, createdAt: old });
    await book.add('fake-1', 3, { sessionId: randomUUID(), createdAt: old });
    await book.add('fake-1', 4, { sessionId: endedSession, createdAt: Date.now() });
    await book.add('gone-node', 5, { sessionId: endedSession, createdAt: old }); // node removed

    const cleaned = await sweepOrphanRooms({
      registry,
      book,
      adminSecret: env.JANUS_ADMIN_SECRET,
      inUse: (room) => Promise.resolve(room.sessionId !== endedSession),
    });
    expect(cleaned).toBe(3);
    expect([...fake.rooms.keys()].sort()).toEqual([3, 4]);
    expect((await book.list()).map((room) => room.roomId).sort()).toEqual([3, 4]);
    expect(await redis.hlen(SFU_ROOMS_KEY)).toBe(2);
    expect(await redis.hexists(SFU_NODES_KEY, 'fake-1')).toBe(1);
    registry.close();
  });
});
