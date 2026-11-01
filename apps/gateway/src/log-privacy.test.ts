import { createCapturingLogger, findSecrets } from '@app/logger/testing';
import { createFakeJanus } from '@app/sfu/testing';
import { type CallTopology, type MatchFound, type SessionResumed } from '@app/shared';
import { type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Gateway } from './gateway.ts';
import {
  appRedis,
  connect,
  connectOutcome,
  newVisitorId,
  nextEvent,
  prisma,
  startGateway,
  testConfigWith,
  tokenFor,
} from './test/helpers.ts';

/**
 * Integration run with a trace-level logger: gateway logs must carry ids only — no tokens,
 * raw IPs (from X-Forwarded-For or inside SDP/ICE), or chat text, even for invalid payloads.
 */
const logs = createCapturingLogger('gateway-log-privacy');
const RAW_IP = '203.0.113.88';
const SDP_IP = '192.0.2.55';
const ICE_IP = '192.0.2.56';
const TEXT = 'LOG-PRIVACY gateway text 5e2b';
const BLOCKED_TEXT = 'LOG-PRIVACY see evil-site.example.com';
const INVALID_TEXT = `LOG-PRIVACY invalid payload ${'x'.repeat(600)}`;
const UNKNOWN_PAYLOAD = 'LOG-PRIVACY unknown event 77aa';
const JANUS_ADMIN_SECRET = 'log-privacy-janus-admin-secret';
const JANUS_TOKEN_SECRET = 'log-privacy-janus-token-secret';
const janus = createFakeJanus({ adminSecret: JANUS_ADMIN_SECRET });
let node: { gateway: Gateway; url: string };
const clients: ClientSocket[] = [];
const tokens: string[] = [];
/** Janus tokens handed to clients (bearer credentials for the media server). */
const janusTokens: string[] = [];

interface AckResult {
  ok: boolean;
  data?: unknown;
  error?: { code: string };
}
const ack = async (socket: ClientSocket, event: string, payload: unknown) =>
  (await socket.timeout(3_000).emitWithAck(event, payload)) as AckResult;

async function visitor(visitorId = newVisitorId()) {
  const token = await tokenFor(visitorId);
  tokens.push(token);
  const socket = connect(node.url, { token, headers: { 'x-forwarded-for': RAW_IP } });
  clients.push(socket);
  expect(await connectOutcome(socket)).toBe('connected');
  await ack(socket, 'ping', {});
  return { socket, visitorId };
}

async function pair(mode: 'text' | 'video', lang: 'fr' | 'it' | 'de') {
  const a = await visitor();
  const b = await visitor();
  const join = { mode, lang, autoRequeue: false };
  const waiting = nextEvent(a.socket, 'queue:waiting');
  await ack(a.socket, 'queue:join', join);
  await waiting;
  const foundA = nextEvent<MatchFound>(a.socket, 'match:found');
  const foundB = nextEvent<MatchFound>(b.socket, 'match:found');
  await ack(b.socket, 'queue:join', join);
  const [matchA, matchB] = await Promise.all([foundA, foundB]);
  await ack(a.socket, 'match:ack', { sessionId: matchA.sessionId });
  await ack(b.socket, 'match:ack', { sessionId: matchB.sessionId });
  return { a, b, matchA, matchB };
}

beforeAll(async () => {
  await appRedis.flushdb();
  node = await startGateway('logs', {
    config: testConfigWith({
      TRUST_PROXY: '127.0.0.1',
      LOG_LEVEL: 'trace',
      NODE_ENV: 'development', // dev:upgradeToSfu
      JANUS_NODES: JSON.stringify([
        { id: 'fj-logs', wsUrl: 'ws://fj-logs.test:8188', adminUrl: 'ws://fj-logs.test:7188' },
      ]),
      JANUS_ADMIN_SECRET,
      JANUS_TOKEN_SECRET,
    }),
    logger: logs.logger,
    sfuSocketFactory: () => janus.createSocket(),
  });
});

afterAll(async () => {
  for (const socket of clients) socket.disconnect();
  await node.gateway.shutdown();
  await prisma.$disconnect();
  await appRedis.quit();
});

describe('gateway logs', () => {
  it('contain ids only — no tokens, raw IPs or chat text', async () => {
    const text = await pair('text', 'fr');
    const sessionId = text.matchA.sessionId;
    expect(
      await ack(text.a.socket, 'chat:message', { sessionId, text: TEXT, clientMsgId: 'm1' }),
    ).toMatchObject({ ok: true });
    expect(
      await ack(text.a.socket, 'chat:message', {
        sessionId,
        text: BLOCKED_TEXT,
        clientMsgId: 'm2',
      }),
    ).toMatchObject({
      error: { code: 'MESSAGE_BLOCKED' },
    });
    expect(
      await ack(text.a.socket, 'chat:message', {
        sessionId,
        text: INVALID_TEXT,
        clientMsgId: 'm3',
      }),
    ).toMatchObject({
      error: { code: 'VALIDATION_FAILED' },
    });
    expect(await ack(text.a.socket, 'debug:dump', { secret: UNKNOWN_PAYLOAD })).toMatchObject({
      error: { code: 'VALIDATION_FAILED' },
    });
    await ack(text.a.socket, 'chat:typing', { sessionId, isTyping: true });

    // Reconnect (new socket, same visitor) and resume the session.
    text.a.socket.disconnect();
    const again = await visitor(text.a.visitorId);
    const resumed = await ack(again.socket, 'session:resume', { sessionId });
    expect((resumed.data as SessionResumed | undefined)?.selfParticipantId).toBe(
      text.matchA.selfParticipantId,
    );
    await ack(again.socket, 'chat:end', { sessionId });

    // Video signaling: SDP and candidates carry IP addresses.
    const video = await pair('video', 'it');
    const to = video.matchA.peers[0]?.participantId ?? '';
    const sdp = `v=0\r\no=- 1 2 IN IP4 ${SDP_IP}\r\ns=-\r\nc=IN IP4 ${SDP_IP}\r\n`;
    await ack(video.a.socket, 'rtc:offer', {
      sessionId: video.matchA.sessionId,
      to,
      sdp: { type: 'offer', sdp },
    });
    await ack(video.a.socket, 'rtc:ice', {
      sessionId: video.matchA.sessionId,
      to,
      candidate: {
        candidate: `candidate:1 1 udp 2122260223 ${ICE_IP} 50000 typ host`,
        sdpMid: '0',
        sdpMLineIndex: 0,
      },
    });
    await ack(video.a.socket, 'chat:end', { sessionId: video.matchA.sessionId });

    // Janus (Part 11): an upgrade hands out tokens; neither they nor the secrets are logged.
    await expect.poll(async () => (await node.gateway.sfuRegistry.pickNode()) !== null).toBe(true);
    const group = await pair('video', 'de');
    const announced = nextEvent<CallTopology>(group.a.socket, 'call:topology');
    expect(
      await ack(group.a.socket, 'dev:upgradeToSfu', { sessionId: group.matchA.sessionId }),
    ).toMatchObject({ ok: true });
    const upgrade = await announced;
    if (upgrade.topology === 'sfu') janusTokens.push(upgrade.sfu.token);
    const refreshed = await ack(group.a.socket, 'call:sfuToken', {
      sessionId: group.matchA.sessionId,
      epoch: upgrade.epoch,
    });
    janusTokens.push((refreshed.data as { token: string }).token);
    await ack(group.a.socket, 'chat:end', { sessionId: group.matchA.sessionId });

    // A forged token is rejected without being logged.
    const forged = `${tokens[0]?.slice(0, -4) ?? ''}AAAA`;
    const rejected = connect(node.url, { token: forged, headers: { 'x-forwarded-for': RAW_IP } });
    clients.push(rejected);
    expect(await connectOutcome(rejected)).toMatchObject({ data: { code: 'TOKEN_INVALID' } });

    const output = logs.text();
    expect(logs.lines.length).toBeGreaterThan(5);
    const secrets: Record<string, string> = {
      'raw IP': RAW_IP,
      'IP inside SDP': SDP_IP,
      'IP inside ICE candidate': ICE_IP,
      'chat text': TEXT,
      'blocked chat text': BLOCKED_TEXT,
      'invalid payload text': 'LOG-PRIVACY invalid payload',
      'unknown event payload': UNKNOWN_PAYLOAD,
      'forged token': forged,
    };
    tokens.forEach((token, index) => (secrets[`visitor token ${String(index)}`] = token));
    expect(janusTokens).toHaveLength(2);
    janusTokens.forEach((token, index) => (secrets[`janus token ${String(index)}`] = token));
    secrets['janus admin secret'] = JANUS_ADMIN_SECRET;
    secrets['janus token secret'] = JANUS_TOKEN_SECRET;
    expect(findSecrets(output, secrets)).toEqual([]);
  });
});
