/**
 * Load mode (Part 10):
 *   pnpm --filter @app/bots load -- --clients 2000 --ramp 30 --duration 60 \
 *     --gateways http://localhost:4001,http://localhost:4011 --workers 4
 *
 * Bots mint visitor JWTs locally with JWT_SECRET (no API call and no Turnstile per bot),
 * connect round-robin, queue with auto-requeue, ack their match, chat at `--msg-rate`, exchange
 * fake SDP/ICE in video sessions (`--video-share`, `--sdp-bytes`, `--ice-count`), and skip after
 * an exponentially distributed session length (`--session-mean`). A bot whose gateway goes away
 * reconnects to the next one and resumes its session. `--workers` processes share the clients.
 *
 * Reports p50/p95/p99 time to match and message delivery latency, ack errors by code, and from
 * each gateway's /metrics: CPU, memory, sockets, matches per bucket, hops per match and
 * sessions ended by reason over the steady phase. `--json <file>` also writes the raw summary.
 *
 * Bots share 127.0.0.1: run the gateways with a high HANDSHAKE_LIMIT_PER_IP.
 */
import { fork } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { createEnv } from '@app/env';
import {
  type ClientToServerEvents,
  type MatchFound,
  type ServerToClientEvents,
  type SessionResumed,
} from '@app/shared';
import { createVisitorTokenService } from '@app/shared/visitor-token';
import { io, type Socket } from 'socket.io-client';
import { z } from 'zod';

/** Plain stdout (not a logger): this is a CLI report. */
const out = (...parts: unknown[]) =>
  process.stdout.write(
    `${parts.map((part) => (typeof part === 'string' ? part : String(part))).join(' ')}\n`,
  );

type BotSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const env = createEnv(
  z.object({
    JWT_SECRET: z.string().min(32),
    NEXT_PUBLIC_GATEWAY_URL: z.url().default('http://localhost:4001'),
  }),
  { service: 'bots-load' },
);

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: {
    clients: { type: 'string', default: '200' },
    ramp: { type: 'string', default: '10' },
    duration: { type: 'string', default: '30' },
    gateways: { type: 'string', default: env.NEXT_PUBLIC_GATEWAY_URL },
    metrics: { type: 'string' },
    workers: { type: 'string', default: '1' },
    lang: { type: 'string', default: 'en' },
    'video-share': { type: 'string', default: '0.5' },
    'session-mean': { type: 'string', default: '20' },
    'msg-rate': { type: 'string', default: '0.2' },
    'sdp-bytes': { type: 'string', default: '4000' },
    'ice-count': { type: 'string', default: '8' },
    json: { type: 'string' },
    child: { type: 'string' },
  },
});

const args = z
  .object({
    clients: z.coerce.number().int().min(2).max(100_000),
    ramp: z.coerce.number().min(0).max(3_600),
    duration: z.coerce.number().min(1).max(86_400),
    gateways: z.string().transform((value) => value.split(',').map((url) => url.trim())),
    metrics: z
      .string()
      .optional()
      .transform((value) => value?.split(',').map((url) => url.trim())),
    workers: z.coerce.number().int().min(1).max(64),
    lang: z.string().length(2),
    'video-share': z.coerce.number().min(0).max(1),
    'session-mean': z.coerce.number().min(0.5).max(3_600),
    'msg-rate': z.coerce.number().min(0).max(10),
    'sdp-bytes': z.coerce.number().int().min(100).max(16_000),
    'ice-count': z.coerce.number().int().min(0).max(50),
    json: z.string().optional(),
    child: z.coerce.number().int().min(0).optional(),
  })
  .parse(values);

// --- Child: runs a share of the bots -------------------------------------------------------

interface ChildResult {
  timeToMatchMs: number[];
  messageLatencyMs: number[];
  counters: Record<string, number>;
  errors: Record<string, number>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Exponentially distributed delay with the given mean (Poisson process). */
const exponential = (meanMs: number) => -Math.log(1 - Math.random()) * meanMs;

/** Send time as letters: the text filter blocks long digit runs as phone numbers. */
const encodeTime = (ms: number) =>
  ms
    .toString(26)
    .split('')
    .map((char) => String.fromCharCode(97 + parseInt(char, 26)))
    .join('');
const decodeTime = (letters: string) =>
  parseInt(
    letters
      .split('')
      .map((char) => (char.charCodeAt(0) - 97).toString(26))
      .join(''),
    26,
  );
const MESSAGE = /^hey ([a-z]{6,12}) how are you$/;

async function runChild(index: number): Promise<ChildResult> {
  const share =
    Math.floor(args.clients / args.workers) + (index < args.clients % args.workers ? 1 : 0);
  const result: ChildResult = { timeToMatchMs: [], messageLatencyMs: [], counters: {}, errors: {} };
  const count = (name: string, by = 1) => {
    result.counters[name] = (result.counters[name] ?? 0) + by;
  };
  const error = (code: string) => {
    result.errors[code] = (result.errors[code] ?? 0) + 1;
  };
  const tokens = createVisitorTokenService({ secret: env.JWT_SECRET, ttlSeconds: 6 * 3_600 });
  const sdp = `v=0\r\n${'a=x-padding\r\n'.repeat(Math.ceil(args['sdp-bytes'] / 13))}`.slice(
    0,
    args['sdp-bytes'],
  );
  let stopping = false;
  const bots: Bot[] = [];

  class Bot {
    private socket: BotSocket | null = null;
    private gatewayIndex: number;
    private joinAt: number | null = null;
    private session: {
      id: string;
      peer: string;
      initiator: boolean;
      mode: 'text' | 'video';
      lastMessageId?: string;
      timers: NodeJS.Timeout[];
    } | null = null;
    private readonly mode: 'text' | 'video';
    private readonly token: string;

    constructor(n: number, token: string) {
      this.token = token;
      this.gatewayIndex = n % args.gateways.length;
      this.mode = Math.random() < args['video-share'] ? 'video' : 'text';
    }

    private emit(event: keyof ClientToServerEvents, payload: unknown): Promise<boolean> {
      const socket = this.socket;
      if (!socket?.connected) return Promise.resolve(false);
      return (
        socket
          .timeout(8_000)
          .emitWithAck(event as 'ping', payload as Record<string, never>) as Promise<{
          ok: boolean;
          error?: { code: string };
        }>
      ).then(
        (ack) => {
          if (!ack.ok) error(`${event}:${ack.error?.code ?? 'unknown'}`);
          return ack.ok;
        },
        () => {
          error(`${event}:timeout`);
          return false;
        },
      );
    }

    connect(): void {
      const url = args.gateways[this.gatewayIndex] ?? args.gateways[0] ?? '';
      const socket: BotSocket = io(url, {
        transports: ['websocket'],
        auth: { token: this.token },
        reconnection: false,
        forceNew: true,
      });
      this.socket = socket;
      socket.on('connect', () => {
        count('connects');
        void this.onConnect();
      });
      socket.on('connect_error', (failure: Error & { data?: { code?: string } }) => {
        error(`connect:${failure.data?.code ?? 'transport'}`);
        socket.close();
        this.retry(1_000);
      });
      socket.on('disconnect', (reason) => {
        if (stopping || reason === 'io client disconnect') return;
        count('disconnects');
        this.retry(250 + randomInt(0, 500));
      });
      socket.on('queue:waiting', () => undefined);
      socket.on('match:found', (match) => {
        this.onMatch(match);
      });
      socket.on('chat:message', (message) => {
        if (this.session?.id !== message.sessionId) return;
        this.session.lastMessageId = message.id;
        const parsed = MESSAGE.exec(message.text);
        if (parsed?.[1] === undefined) {
          count('messagesUnparsed');
          return;
        }
        count('messagesReceived');
        result.messageLatencyMs.push(Date.now() - decodeTime(parsed[1]));
      });
      socket.on('rtc:offer', (offer) => {
        if (this.session?.id !== offer.sessionId) return;
        count('offersReceived');
        void this.emit('rtc:answer', { sessionId: offer.sessionId, to: offer.from, sdp });
        this.sendCandidates();
      });
      socket.on('rtc:answer', () => {
        count('answersReceived');
      });
      socket.on('rtc:ice', () => {
        count('iceReceived');
      });
      socket.on('peer:left', (left) => {
        if (this.session?.id !== left.sessionId) return;
        count(`peerLeft:${left.reason}`);
        this.endSession();
        // Like the web client: requeue shortly after the stranger left.
        setTimeout(
          () => {
            if (stopping || this.session !== null) return;
            this.join();
          },
          100 + randomInt(0, 300),
        );
      });
      socket.on('system:notice', (notice) => {
        count(`notice:${notice.code}`);
        if (notice.code === 'SERVER_RESTARTING') {
          socket.close();
          this.retry(250 + randomInt(0, 250));
        }
      });
    }

    private retry(delayMs: number): void {
      if (stopping) return;
      this.socket?.removeAllListeners();
      this.socket?.close();
      this.socket = null;
      this.gatewayIndex = (this.gatewayIndex + 1) % args.gateways.length;
      count('reconnects');
      setTimeout(() => {
        if (!stopping) this.connect();
      }, delayMs);
    }

    private async onConnect(): Promise<void> {
      const session = this.session;
      if (session === null) {
        this.join();
        return;
      }
      const socket = this.socket;
      if (socket === null) return;
      try {
        const ack = (await socket.timeout(8_000).emitWithAck('session:resume', {
          sessionId: session.id,
          ...(session.lastMessageId === undefined ? {} : { lastMessageId: session.lastMessageId }),
        })) as { ok: boolean; data?: SessionResumed };
        if (ack.ok) {
          count('resumesOk');
          return;
        }
      } catch {
        // timed out: treat as not resumable
      }
      count('resumesFailed');
      this.endSession();
      this.join();
    }

    private join(): void {
      if (stopping) return;
      this.joinAt = Date.now();
      void this.emit('queue:join', { mode: this.mode, lang: args.lang, autoRequeue: true });
    }

    private onMatch(match: MatchFound): void {
      count('matches');
      if (this.joinAt !== null) result.timeToMatchMs.push(Date.now() - this.joinAt);
      this.joinAt = null;
      this.endSession();
      const peer = match.peers[0];
      if (peer === undefined) return;
      this.session = {
        id: match.sessionId,
        peer: peer.participantId,
        initiator: peer.initiator,
        mode: match.mode,
        timers: [],
      };
      void this.emit('match:ack', { sessionId: match.sessionId });
      const session = this.session;
      session.timers.push(
        setTimeout(
          () => {
            this.skip(session.id);
          },
          exponential(args['session-mean'] * 1_000),
        ),
      );
      if (args['msg-rate'] > 0) this.scheduleMessage(session.id);
      if (match.mode === 'video' && session.initiator) {
        // `peers[i].initiator` = this client makes the first offer to that peer.
        session.timers.push(
          setTimeout(() => {
            void this.emit('rtc:offer', { sessionId: session.id, to: session.peer, sdp });
            this.sendCandidates();
          }, 30),
        );
      }
    }

    private sendCandidates(): void {
      const session = this.session;
      if (session === null) return;
      for (let i = 0; i < args['ice-count']; i += 1) {
        session.timers.push(
          setTimeout(
            () => {
              count('iceSent');
              void this.emit('rtc:ice', {
                sessionId: session.id,
                to: session.peer,
                candidate: {
                  candidate: `candidate:${String(i)} 1 udp 2122260223 192.0.2.${String(i + 1)} ${String(50_000 + i)} typ host generation 0 ufrag abcd network-id 1`,
                  sdpMid: '0',
                  sdpMLineIndex: 0,
                },
              });
            },
            20 * (i + 1),
          ),
        );
      }
    }

    private scheduleMessage(sessionId: string): void {
      const session = this.session;
      if (session?.id !== sessionId) return;
      session.timers.push(
        setTimeout(
          () => {
            if (this.session?.id !== sessionId) return;
            count('messagesSent');
            void this.emit('chat:message', {
              sessionId,
              text: `hey ${encodeTime(Date.now())} how are you`,
              clientMsgId: randomUUID(),
            });
            this.scheduleMessage(sessionId);
          },
          exponential(1_000 / args['msg-rate']),
        ),
      );
    }

    private skip(sessionId: string): void {
      if (this.session?.id !== sessionId || stopping) return;
      count('skips');
      this.endSession();
      this.joinAt = Date.now(); // the server requeues the skipper (auto-requeue)
      // Like the web client (D-068): a session the server no longer knows (it ended, or Redis
      // lost it) means "search again".
      void this.emit('chat:next', { sessionId }).then((ok) => {
        if (!ok && !stopping && this.session === null) this.join();
      });
    }

    private endSession(): void {
      for (const timer of this.session?.timers ?? []) clearTimeout(timer);
      this.session = null;
    }

    stop(): void {
      const session = this.session;
      this.endSession();
      if (session !== null) void this.emit('chat:end', { sessionId: session.id });
      setTimeout(() => this.socket?.close(), 500);
    }
  }

  const rampMs = args.ramp * 1_000;
  for (let n = 0; n < share; n += 1) {
    const { token } = await tokens.issue(randomUUID());
    const bot = new Bot(n * args.workers + index, token);
    bots.push(bot);
    const startAt = share <= 1 ? 0 : (rampMs * n) / share;
    setTimeout(() => {
      if (!stopping) bot.connect();
    }, startAt);
  }
  process.send?.({ type: 'started', bots: share });
  await sleep(rampMs + args.duration * 1_000);
  stopping = true;
  for (const bot of bots) bot.stop();
  await sleep(1_500);
  return result;
}

// --- Parent: forks children, samples gateway metrics, prints the summary ---------------------

/** Sample value of `metric` whose labels include all of `labels` (summed over matches). */
function metricSum(body: string, metric: string, labels: Record<string, string> = {}): number {
  let sum = 0;
  for (const line of body.split('\n')) {
    if (!(line.startsWith(`${metric}{`) || line.startsWith(`${metric} `))) continue;
    if (!Object.entries(labels).every(([key, value]) => line.includes(`${key}="${value}"`))) {
      continue;
    }
    sum += Number(line.slice(line.lastIndexOf(' ') + 1));
  }
  return sum;
}

function labelValues(body: string, metric: string, label: string): string[] {
  const found = new Set<string>();
  const pattern = new RegExp(`${label}="([^"]*)"`);
  for (const line of body.split('\n')) {
    if (!line.startsWith(`${metric}{`)) continue;
    const value = pattern.exec(line)?.[1];
    if (value !== undefined) found.add(value);
  }
  return [...found].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
}

async function scrape(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    return response.ok ? await response.text() : null;
  } catch {
    return null;
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? Number.NaN;
}

async function runParent(): Promise<void> {
  const metricsUrls = args.metrics ?? args.gateways.map((url) => `${url}/metrics`);
  const started = Date.now();
  const steadyAt = started + args.ramp * 1_000;
  const endAt = steadyAt + args.duration * 1_000;
  out(
    `load: ${String(args.clients)} clients over ${String(args.workers)} process(es), ramp ${String(args.ramp)} s, steady ${String(args.duration)} s, gateways ${args.gateways.join(', ')}`,
  );

  const children = Array.from({ length: args.workers }, (_, index) =>
    fork(process.argv[1] ?? '', [...process.argv.slice(2), '--child', String(index)], {
      execArgv: process.execArgv,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    }),
  );
  const results = Promise.all(
    children.map(
      (child) =>
        new Promise<ChildResult>((resolve, reject) => {
          child.on('message', (message: { type: string; result?: ChildResult }) => {
            if (message.type === 'result' && message.result !== undefined) resolve(message.result);
          });
          child.on('exit', (code) => {
            if (code !== 0) reject(new Error(`load worker exited with ${String(code)}`));
          });
        }),
    ),
  );

  // Gateway samples: CPU and memory every 5 s, counters at the start and end of the steady phase.
  const samples = new Map<string, { at: number; cpu: number; rss: number; sockets: number }[]>();
  const sampleAll = async () => {
    const bodies = new Map<string, string>();
    await Promise.all(
      metricsUrls.map(async (url) => {
        const body = await scrape(url);
        if (body === null) return;
        bodies.set(url, body);
        const list = samples.get(url) ?? [];
        list.push({
          at: Date.now(),
          cpu: metricSum(body, 'process_cpu_seconds_total'),
          rss: metricSum(body, 'process_resident_memory_bytes'),
          sockets: metricSum(body, 'gateway_sockets_connected'),
        });
        samples.set(url, list);
      }),
    );
    return bodies;
  };
  const timer = setInterval(() => void sampleAll(), 5_000);
  await sleep(Math.max(0, steadyAt - Date.now()));
  const atSteady = await sampleAll();
  await sleep(Math.max(0, endAt - Date.now()));
  const atEnd = await sampleAll();
  clearInterval(timer);

  const merged: ChildResult = { timeToMatchMs: [], messageLatencyMs: [], counters: {}, errors: {} };
  for (const result of await results) {
    merged.timeToMatchMs.push(...result.timeToMatchMs);
    merged.messageLatencyMs.push(...result.messageLatencyMs);
    for (const [key, value] of Object.entries(result.counters)) {
      merged.counters[key] = (merged.counters[key] ?? 0) + value;
    }
    for (const [key, value] of Object.entries(result.errors)) {
      merged.errors[key] = (merged.errors[key] ?? 0) + value;
    }
  }

  const ms = (value: number) => (Number.isNaN(value) ? '–' : `${String(Math.round(value))} ms`);
  const summary: Record<string, unknown> = {
    clients: args.clients,
    workers: args.workers,
    timeToMatch: {
      count: merged.timeToMatchMs.length,
      p50: percentile(merged.timeToMatchMs, 50),
      p95: percentile(merged.timeToMatchMs, 95),
      p99: percentile(merged.timeToMatchMs, 99),
    },
    messageLatency: {
      count: merged.messageLatencyMs.length,
      p50: percentile(merged.messageLatencyMs, 50),
      p95: percentile(merged.messageLatencyMs, 95),
      p99: percentile(merged.messageLatencyMs, 99),
    },
    counters: merged.counters,
    errors: merged.errors,
    gateways: {},
  };
  out('\n== Clients');
  out(
    `time to match: n=${String(merged.timeToMatchMs.length)} p50 ${ms(percentile(merged.timeToMatchMs, 50))} p95 ${ms(percentile(merged.timeToMatchMs, 95))} p99 ${ms(percentile(merged.timeToMatchMs, 99))}`,
  );
  out(
    `message latency: n=${String(merged.messageLatencyMs.length)} p50 ${ms(percentile(merged.messageLatencyMs, 50))} p95 ${ms(percentile(merged.messageLatencyMs, 95))} p99 ${ms(percentile(merged.messageLatencyMs, 99))}`,
  );
  out('counters:', JSON.stringify(merged.counters));
  const totalErrors = Object.values(merged.errors).reduce((a, b) => a + b, 0);
  out(`errors (${String(totalErrors)}):`, JSON.stringify(merged.errors));

  out('\n== Gateways (steady phase)');
  const seconds = args.duration;
  const gateways: Record<string, unknown> = {};
  for (const url of metricsUrls) {
    const first = atSteady.get(url);
    const last = atEnd.get(url);
    const list = samples.get(url) ?? [];
    if (first === undefined || last === undefined) {
      out(`${url}: no metrics`);
      continue;
    }
    const delta = (metric: string, labels: Record<string, string> = {}) =>
      metricSum(last, metric, labels) - metricSum(first, metric, labels);
    const cpuPercent = (delta('process_cpu_seconds_total') / seconds) * 100;
    const peakRss = Math.max(...list.map((sample) => sample.rss)) / 1_048_576;
    const peakSockets = Math.max(...list.map((sample) => sample.sockets));
    const matches = delta('matchmaking_matches_total');
    const perBucket = Object.fromEntries(
      labelValues(last, 'matchmaking_matches_total', 'bucket').map((bucket) => [
        bucket,
        Number((delta('matchmaking_matches_total', { bucket }) / seconds).toFixed(2)),
      ]),
    );
    const hops = delta('matchmaking_bucket_hops_total');
    const ended = Object.fromEntries(
      labelValues(last, 'sessions_ended_total', 'reason').map((reason) => [
        reason,
        delta('sessions_ended_total', { reason }),
      ]),
    );
    const events = delta('gateway_events_total') / seconds;
    const entry = {
      cpuPercent: Number(cpuPercent.toFixed(1)),
      peakRssMb: Number(peakRss.toFixed(0)),
      peakSockets,
      matchesPerSec: Number((matches / seconds).toFixed(2)),
      matchesPerSecByBucket: perBucket,
      hopsPerMatch: matches > 0 ? Number((hops / matches).toFixed(3)) : null,
      sessionsEnded: ended,
      eventsPerSec: Number(events.toFixed(1)),
      rateLimited: delta('rate_limit_hits_total'),
    };
    gateways[url] = entry;
    out(`${url}: ${JSON.stringify(entry)}`);
  }
  summary.gateways = gateways;
  if (args.json !== undefined) writeFileSync(args.json, `${JSON.stringify(summary, null, 2)}\n`);
  process.exit(0);
}

if (args.child === undefined) {
  await runParent();
} else {
  const result = await runChild(args.child);
  process.send?.({ type: 'result', result }, () => {
    process.exit(0);
  });
}
