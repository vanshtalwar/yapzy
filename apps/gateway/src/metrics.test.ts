import { type MatchFound } from '@app/shared';
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
  testConfigWith,
  tokenFor,
} from './test/helpers.ts';

let node: { gateway: Gateway; url: string };
const clients: ClientSocket[] = [];
const METRICS_TOKEN = 'gateway-metrics-token-0123';

interface AckResult {
  ok: boolean;
  data?: unknown;
}
const ack = async (socket: ClientSocket, event: string, payload: unknown) =>
  (await socket.timeout(3_000).emitWithAck(event, payload)) as AckResult;

async function visitor() {
  const socket = await connected(node.url, await tokenFor(newVisitorId()));
  clients.push(socket);
  await ack(socket, 'ping', {});
  return socket;
}

/** The value of the first sample of `metric` that has all `labels` (label order varies). */
function sampleValue(body: string, metric: string, labels: Record<string, string> = {}): number {
  const line = body
    .split('\n')
    .find(
      (candidate) =>
        (candidate.startsWith(`${metric}{`) || candidate.startsWith(`${metric} `)) &&
        Object.entries(labels).every(([key, value]) => candidate.includes(`${key}="${value}"`)),
    );
  return line === undefined ? Number.NaN : Number(line.slice(line.lastIndexOf(' ') + 1));
}

beforeAll(async () => {
  await appRedis.flushdb();
  node = await startGateway('metrics', { config: testConfigWith({ METRICS_TOKEN }) });
});

afterAll(async () => {
  for (const socket of clients) socket.disconnect();
  await node.gateway.shutdown();
  await prisma.$disconnect();
  await appRedis.quit();
});

describe('gateway /metrics', () => {
  it('requires the bearer token', async () => {
    expect((await fetch(`${node.url}/metrics`)).status).toBe(401);
  });

  it('counts sockets, events, matches, time to match and ended sessions', async () => {
    const a = await visitor();
    const b = await visitor();
    const join = { mode: 'text', lang: 'pt', autoRequeue: false };
    const waiting = nextEvent(a, 'queue:waiting');
    await ack(a, 'queue:join', join);
    await waiting;
    const found = nextEvent<MatchFound>(a, 'match:found');
    await ack(b, 'queue:join', join);
    const { sessionId } = await found;
    await ack(a, 'chat:message', { sessionId, text: 'see example.com', clientMsgId: 'm1' });
    await ack(a, 'not:an:event', {});
    await ack(a, 'chat:end', { sessionId });

    const response = await fetch(`${node.url}/metrics`, {
      headers: { authorization: `Bearer ${METRICS_TOKEN}` },
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(sampleValue(body, 'gateway_sockets_connected')).toBe(2);
    expect(sampleValue(body, 'matchmaking_matches_total', { mode: 'text', bucket: '0' })).toBe(1);
    expect(sampleValue(body, 'matchmaking_time_to_match_seconds_count', { mode: 'text' })).toBe(2);
    expect(sampleValue(body, 'sessions_ended_total', { mode: 'text', reason: 'STOP' })).toBe(1);
    expect(sampleValue(body, 'session_duration_seconds_count', { mode: 'text' })).toBe(1);
    expect(sampleValue(body, 'gateway_events_total', { event: 'queue:join', outcome: 'ok' })).toBe(
      2,
    );
    expect(
      sampleValue(body, 'gateway_events_total', { event: 'chat:message', outcome: 'error' }),
    ).toBe(1);
    expect(
      sampleValue(body, 'gateway_events_total', { event: 'unknown', outcome: 'invalid' }),
    ).toBe(1);
    expect(
      sampleValue(body, 'moderation_actions_total', { source: 'text_filter', action: 'block' }),
    ).toBe(1);
  });

  it('exports rtc:summary aggregates', () => {
    node.gateway.rtcStats.record({
      sessionId: '00000000-0000-7000-8000-000000000001',
      peer: 'pPeer0000001',
      failed: false,
      localCandidateType: 'relay',
      remoteCandidateType: 'relay',
      timeToConnectedMs: 420,
      avgRttMs: 80,
      avgBitrateKbps: 600,
    });
    return node.gateway.metrics.registry.metrics().then((body) => {
      expect(sampleValue(body, 'rtc_summaries_total', { outcome: 'connected' })).toBe(1);
      expect(sampleValue(body, 'rtc_local_candidates_total', { type: 'relay' })).toBe(1);
      expect(sampleValue(body, 'rtc_time_to_connected_seconds_count')).toBe(1);
    });
  });
});
