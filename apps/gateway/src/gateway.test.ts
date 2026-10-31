import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { PRESENCE_NODES_KEY, presenceNodeKey, visitorRoom, visitorSocketKey } from '@app/redis';
import { type SystemNotice } from '@app/shared';
import { type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Gateway } from './gateway.ts';
import {
  appRedis,
  connect,
  connected,
  connectOutcome,
  newVisitorId,
  nextEvent,
  prisma,
  startGateway,
  tokenFor,
} from './test/helpers.ts';

let nodeA: { gateway: Gateway; url: string };
let nodeB: { gateway: Gateway; url: string };
const clients: ClientSocket[] = [];
const visitorIds: string[] = [];

function track(socket: ClientSocket): ClientSocket {
  clients.push(socket);
  return socket;
}

/** Connects and waits until the server has fully registered the socket (ping round-trip). */
async function connectVisitor(url: string, visitorId: string = newVisitorId()) {
  const socket = track(await connected(url, await tokenFor(visitorId)));
  await socket.timeout(2_000).emitWithAck('ping', {});
  return { socket, visitorId };
}

beforeAll(async () => {
  await appRedis.flushdb();
  nodeA = await startGateway('a');
  nodeB = await startGateway('b');
});

afterAll(async () => {
  for (const socket of clients) socket.disconnect();
  await Promise.all([nodeA.gateway.shutdown(), nodeB.gateway.shutdown()]);
  await prisma.ban.deleteMany({ where: { visitorId: { in: visitorIds } } });
  await prisma.visitor.deleteMany({ where: { id: { in: visitorIds } } });
  await prisma.$disconnect();
  await appRedis.quit();
});

describe('handshake', () => {
  it('rejects missing, invalid and expired tokens with distinct codes', async () => {
    const missing = await connectOutcome(track(connect(nodeA.url)));
    expect(missing).toMatchObject({ data: { code: 'UNAUTHORIZED' } });

    const invalid = await connectOutcome(track(connect(nodeA.url, { token: 'not.a.jwt' })));
    expect(invalid).toMatchObject({ data: { code: 'TOKEN_INVALID' } });

    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const expiredToken = await tokenFor(newVisitorId(), twoHoursAgo);
    const expired = await connectOutcome(track(connect(nodeA.url, { token: expiredToken })));
    expect(expired).toMatchObject({ data: { code: 'TOKEN_EXPIRED' } });
  });

  it('rejects hard-banned visitors and silently routes shadow-banned ones to the shadow pool', async () => {
    const [hard, shadow] = await Promise.all(
      [0, 1].map(() =>
        prisma.visitor.create({ data: { deviceIdHash: randomBytes(32).toString('hex') } }),
      ),
    );
    if (hard === undefined || shadow === undefined) throw new Error('visitor setup failed');
    visitorIds.push(hard.id, shadow.id);
    await prisma.ban.createMany({
      data: [
        { visitorId: hard.id, type: 'HARD', reason: 'test' },
        { visitorId: shadow.id, type: 'SHADOW', reason: 'test' },
      ],
    });

    const banned = await connectOutcome(
      track(connect(nodeA.url, { token: await tokenFor(hard.id) })),
    );
    expect(banned).toMatchObject({ data: { code: 'BANNED', expiresAt: null } });

    await connectVisitor(nodeA.url, shadow.id);
    const serverSockets = await nodeA.gateway.io.local.in(visitorRoom(shadow.id)).fetchSockets();
    expect(serverSockets.map((socket) => socket.data.pool)).toEqual(['shadow']);
  });

  it('rejects connections from origins not in CORS_ORIGINS', async () => {
    const socket = track(
      connect(nodeA.url, { token: await tokenFor(newVisitorId()), origin: 'https://evil.example' }),
    );
    expect(await connectOutcome(socket)).not.toBe('connected');
  });
});

describe('events', () => {
  it('answers ping with the server time', async () => {
    const { socket } = await connectVisitor(nodeA.url);
    const response: unknown = await socket.timeout(2_000).emitWithAck('ping', {});
    expect(response).toMatchObject({
      ok: true,
      data: { serverTime: expect.any(Number) as number },
    });
  });

  it('acks invalid payloads, stubs and unknown events with the error envelope', async () => {
    const { socket } = await connectVisitor(nodeA.url);
    expect(await socket.timeout(2_000).emitWithAck('queue:join', { mode: 'audio' })).toEqual({
      ok: false,
      error: { code: 'VALIDATION_FAILED', message: 'Invalid payload for queue:join' },
    });
    expect(
      await socket.timeout(2_000).emitWithAck('queue:join', { mode: 'text', lang: 'en' }),
    ).toMatchObject({ ok: false, error: { code: 'NOT_IMPLEMENTED' } });
    expect(await socket.timeout(2_000).emitWithAck('admin:delete_everything', {})).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', message: 'Unknown event' },
    });
  });

  it('rate limits bursts per socket with RATE_LIMITED acks', async () => {
    const { socket } = await connectVisitor(nodeA.url);
    const responses = (await Promise.all(
      Array.from({ length: 30 }, () => socket.timeout(2_000).emitWithAck('ping', {})),
    )) as { ok: boolean; error?: { code: string } }[];
    const ok = responses.filter((response) => response.ok).length;
    const limited = responses.filter((response) => response.error?.code === 'RATE_LIMITED').length;
    // Bucket capacity 20, one token already spent by connectVisitor's ping.
    expect(ok).toBeGreaterThanOrEqual(19);
    expect(limited).toBeGreaterThan(0);
    expect(ok + limited).toBe(30);
  });

  it('disconnects sockets that keep sending garbage', async () => {
    const { socket } = await connectVisitor(nodeA.url);
    const notice = nextEvent<SystemNotice>(socket, 'system:notice');
    const disconnected = nextEvent<string>(socket, 'disconnect');
    for (let i = 0; i < 60; i += 1) socket.emit('garbage:event', { i });
    expect((await notice).code).toBe('RATE_LIMITED');
    expect(await disconnected).toBe('io server disconnect');
  });
});

describe('cross-node behaviour', () => {
  it('delivers emits to a visitor room on another node via the sharded adapter', async () => {
    const { socket, visitorId } = await connectVisitor(nodeB.url);
    const received = nextEvent<SystemNotice>(socket, 'system:notice');
    nodeA.gateway.io.to(visitorRoom(visitorId)).emit('system:notice', {
      code: 'MESSAGE_BLOCKED',
      message: 'cross-node test',
    });
    expect(await received).toEqual({ code: 'MESSAGE_BLOCKED', message: 'cross-node test' });
  });

  it('keeps one socket per visitor: a second connection on another node kicks the first', async () => {
    const visitorId = newVisitorId();
    const { socket: first } = await connectVisitor(nodeA.url, visitorId);
    const notice = nextEvent<SystemNotice>(first, 'system:notice');
    const kicked = nextEvent<string>(first, 'disconnect');

    const { socket: second } = await connectVisitor(nodeB.url, visitorId);
    expect((await notice).code).toBe('SESSION_REPLACED');
    expect(await kicked).toBe('io server disconnect');

    await sleep(200);
    expect(second.connected).toBe(true);
    expect(await appRedis.get(visitorSocketKey(visitorId))).toBe(second.id);
  });
});

describe('presence & lifecycle', () => {
  it('serves /health and /ready on the HTTP server', async () => {
    expect(await (await fetch(`${nodeA.url}/health`)).json()).toEqual({ status: 'ok' });
    const ready = await fetch(`${nodeA.url}/ready`);
    expect(ready.status).toBe(200);
  });

  it('publishes per-node socket counts that disappear when the node shuts down', async () => {
    const nodeC = await startGateway('c', { drainTimeoutMs: 2_000 });
    const { socket } = await connectVisitor(nodeC.url);
    await nodeC.gateway.presence.refresh();

    const key = presenceNodeKey(nodeC.gateway.nodeId);
    expect(await appRedis.get(key)).toBe('1');
    const ttl = await appRedis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(15);
    expect(await appRedis.smembers(PRESENCE_NODES_KEY)).toEqual(
      expect.arrayContaining([nodeA.gateway.nodeId, nodeB.gateway.nodeId, nodeC.gateway.nodeId]),
    );

    // Graceful shutdown: notice first, then the client leaves within the drain window.
    const notice = nextEvent<SystemNotice>(socket, 'system:notice');
    const stopped = nodeC.gateway.shutdown();
    expect((await notice).code).toBe('SERVER_RESTARTING');
    socket.disconnect(); // a real client would now reconnect to another node
    await stopped;

    expect(await appRedis.exists(key)).toBe(0);
    expect(await appRedis.smembers(PRESENCE_NODES_KEY)).not.toContain(nodeC.gateway.nodeId);
  });
});
