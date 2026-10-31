/**
 * Load/functional bots:
 *   pnpm bots -- --clients 20 --gateways http://localhost:4001,http://localhost:4011 \
 *                --mode text --duration 60
 *
 * Each bot starts a real session through the API, connects to a random gateway, queues with
 * random interests, chats a little, then skips or ends, and repeats. At the end it prints
 * matches, message delivery, protocol errors and time-to-match percentiles, and verifies that
 * every match was symmetric. Exit code 1 if anything was wrong.
 *
 * More than 10 clients need the API's session rate limit off: run the API with
 * RATE_LIMIT_DISABLED=true (honoured only in development).
 */
import { randomInt } from 'node:crypto';
import { parseArgs } from 'node:util';

import { createEnv } from '@app/env';
import { type ClientToServerEvents, type MatchFound, type ServerToClientEvents } from '@app/shared';
import { io, type Socket } from 'socket.io-client';
import { z } from 'zod';

import { startSession } from './session.ts';

type BotSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const env = createEnv(
  z.object({
    NEXT_PUBLIC_API_URL: z.url().default('http://localhost:4000'),
    NEXT_PUBLIC_GATEWAY_URL: z.url().default('http://localhost:4001'),
  }),
  { service: 'bots' },
);

const { values } = parseArgs({
  // `pnpm bots -- --x` forwards a literal "--"; drop it so options still parse.
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: {
    clients: { type: 'string', default: '20' },
    gateways: { type: 'string', default: env.NEXT_PUBLIC_GATEWAY_URL },
    api: { type: 'string', default: env.NEXT_PUBLIC_API_URL },
    mode: { type: 'string', default: 'text' },
    lang: { type: 'string', default: 'en' },
    duration: { type: 'string', default: '60' },
  },
});

const args = z
  .object({
    clients: z.coerce.number().int().min(2).max(1_000),
    gateways: z.string().transform((value) => value.split(',').map((url) => url.trim())),
    api: z.url(),
    mode: z.enum(['text', 'video']),
    lang: z.string().min(2).max(2),
    duration: z.coerce.number().int().min(5).max(3_600),
  })
  .parse(values);

const INTEREST_POOL = ['music', 'games', 'movies', 'travel', 'tech', 'books'];
/** Ack failures that are legitimate races (peer left while we acted), not protocol errors. */
const BENIGN_RACE_CODES = new Set(['NOT_IN_SESSION', 'INVALID_STATE']);
const ACK_TIMEOUT_MS = 5_000;

const stats = {
  matches: 0,
  messagesSent: 0,
  messagesReceived: 0,
  /** Delivered for a session this bot had just left (it skipped while the peer was typing). */
  messagesLate: 0,
  skips: 0,
  ends: 0,
  races: 0,
  protocolErrors: [] as string[],
  timeToMatchMs: [] as number[],
};
/** sessionId → what each side was told in match:found. */
const sessions = new Map<string, { selfPid: string; peerPid: string; initiator: boolean }[]>();

let stopping = false;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const pick = <T>(items: readonly T[]): T => items[randomInt(0, items.length)] as T;

function protocolError(bot: number, what: string): void {
  stats.protocolErrors.push(`bot ${String(bot)}: ${what}`);
}

class Bot {
  private readonly id: number;
  private readonly socket: BotSocket;
  private phase: 'idle' | 'joining' | 'waiting' | 'in_session' = 'idle';
  private session: { sessionId: string; selfPid: string; peerPid: string } | null = null;
  /** Sessions this bot has been in, to tell late deliveries from misrouted ones. */
  private readonly pastSessions = new Set<string>();
  private joinedAt = 0;

  /**
   * Read through a method on purpose: event handlers (match:found, peer:left) change `phase`
   * while an ack is pending, which TypeScript's narrowing cannot see.
   */
  private currentPhase(): Bot['phase'] {
    return this.phase;
  }

  constructor(id: number, socket: BotSocket) {
    this.id = id;
    this.socket = socket;
    socket.on('match:found', (match) => {
      this.onMatch(match);
    });
    socket.on('peer:left', (left) => {
      if (left.sessionId !== this.session?.sessionId) return; // stale, ignore
      if (left.sessionEnded) this.becomeIdle();
    });
    socket.on('chat:message', (message) => {
      if (message.sessionId !== this.session?.sessionId) {
        if (this.pastSessions.has(message.sessionId)) stats.messagesLate += 1;
        else protocolError(this.id, 'chat:message for a session this bot was never in');
        return;
      }
      if (message.from !== this.session.peerPid) protocolError(this.id, 'misrouted chat:message');
      stats.messagesReceived += 1;
    });
    socket.on('system:notice', (notice) => {
      if (notice.code !== 'SERVER_RESTARTING') protocolError(this.id, `notice ${notice.code}`);
    });
    socket.on('disconnect', (reason) => {
      if (!stopping) protocolError(this.id, `disconnected: ${reason}`);
    });
  }

  private async call(event: keyof ClientToServerEvents, payload: object): Promise<boolean> {
    try {
      const response = (await this.socket
        .timeout(ACK_TIMEOUT_MS)
        .emitWithAck(event, payload as never)) as { ok: boolean; error?: { code: string } };
      if (response.ok) return true;
      const code = response.error?.code ?? 'UNKNOWN';
      if (BENIGN_RACE_CODES.has(code)) stats.races += 1;
      else protocolError(this.id, `${event} → ${code}`);
      return false;
    } catch {
      protocolError(this.id, `${event} ack timeout`);
      return false;
    }
  }

  private becomeIdle(): void {
    this.session = null;
    this.phase = 'idle';
    void sleep(randomInt(50, 300)).then(() => this.join());
  }

  async join(): Promise<void> {
    if (stopping || this.phase !== 'idle') return;
    this.phase = 'joining';
    this.joinedAt = performance.now();
    const interests = Array.from({ length: randomInt(0, 3) }, () => pick(INTEREST_POOL));
    const ok = await this.call('queue:join', { mode: args.mode, lang: args.lang, interests });
    if (this.currentPhase() === 'joining') this.phase = ok ? 'waiting' : 'idle';
    if (!ok && this.currentPhase() === 'idle') void sleep(200).then(() => this.join());
  }

  private onMatch(match: MatchFound): void {
    const peer = match.peers[0];
    if (peer === undefined || match.peers.length !== 1) {
      protocolError(this.id, 'match:found without exactly one peer');
      return;
    }
    stats.matches += 1;
    stats.timeToMatchMs.push(performance.now() - this.joinedAt);
    const record = {
      selfPid: match.selfParticipantId,
      peerPid: peer.participantId,
      initiator: peer.initiator,
    };
    sessions.set(match.sessionId, [...(sessions.get(match.sessionId) ?? []), record]);
    this.session = { sessionId: match.sessionId, selfPid: record.selfPid, peerPid: record.peerPid };
    this.pastSessions.add(match.sessionId);
    this.phase = 'in_session';
    void this.converse(match.sessionId);
  }

  private async converse(sessionId: string): Promise<void> {
    const messages = randomInt(1, 4);
    for (let i = 0; i < messages; i += 1) {
      await sleep(randomInt(100, 400));
      if (stopping || this.session?.sessionId !== sessionId) return;
      if (
        await this.call('chat:message', {
          sessionId,
          text: `hello #${String(i)}`,
          clientMsgId: `m${String(i)}`,
        })
      ) {
        stats.messagesSent += 1;
      }
    }
    await sleep(randomInt(100, 600));
    if (stopping || this.session?.sessionId !== sessionId) return;

    if (randomInt(0, 2) === 0) {
      stats.skips += 1;
      this.session = null;
      this.phase = 'joining';
      this.joinedAt = performance.now();
      const ok = await this.call('chat:next', { sessionId });
      if (this.currentPhase() === 'joining') this.phase = ok ? 'waiting' : 'idle';
      if (!ok && this.currentPhase() === 'idle') this.becomeIdle();
    } else {
      stats.ends += 1;
      this.session = null;
      this.phase = 'joining'; // block peer:left re-joins until our own end is acknowledged
      await this.call('chat:end', { sessionId });
      if (this.currentPhase() === 'joining') this.becomeIdle();
    }
  }

  disconnect(): void {
    this.socket.disconnect();
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

async function main(): Promise<number> {
  const out = (line: string) => process.stdout.write(`${line}\n`);
  out(
    `starting ${String(args.clients)} bots (${args.mode}, ${args.lang}) for ${String(args.duration)} s`,
  );

  const bots: Bot[] = [];
  for (let i = 0; i < args.clients; i += 1) {
    const { token } = await startSession(args.api);
    const socket: BotSocket = io(pick(args.gateways), {
      transports: ['websocket'],
      auth: { token },
      reconnection: false,
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    bots.push(new Bot(i + 1, socket));
  }
  out(`all ${String(bots.length)} bots connected; running…`);
  for (const bot of bots) void bot.join();

  await sleep(args.duration * 1_000);
  stopping = true;
  await sleep(1_500); // let in-flight match:found / messages land before judging symmetry
  for (const bot of bots) bot.disconnect();

  let asymmetric = 0;
  for (const [sessionId, sides] of sessions) {
    const [x, y] = sides;
    const symmetric =
      sides.length === 2 &&
      x?.selfPid === y?.peerPid &&
      y?.selfPid === x?.peerPid &&
      x?.initiator !== y?.initiator;
    if (!symmetric) {
      asymmetric += 1;
      if (asymmetric <= 5) out(`  asymmetric session ${sessionId}: ${JSON.stringify(sides)}`);
    }
  }

  const ttm = [...stats.timeToMatchMs].sort((a, b) => a - b);
  out('');
  out('── bot run summary ─────────────────────────────');
  out(`sessions            ${String(sessions.size)} (asymmetric: ${String(asymmetric)})`);
  out(`match:found events  ${String(stats.matches)}`);
  out(
    `messages            sent ${String(stats.messagesSent)}, received ${String(stats.messagesReceived)} + ${String(stats.messagesLate)} after the receiver had moved on`,
  );
  out(`skips / ends        ${String(stats.skips)} / ${String(stats.ends)}`);
  out(
    `benign races        ${String(stats.races)} (NOT_IN_SESSION / INVALID_STATE after a peer left)`,
  );
  out(
    `time to match       p50 ${percentile(ttm, 50).toFixed(0)} ms, p95 ${percentile(ttm, 95).toFixed(0)} ms`,
  );
  out(`protocol errors     ${String(stats.protocolErrors.length)}`);
  for (const error of stats.protocolErrors.slice(0, 10)) out(`  ${error}`);

  return stats.protocolErrors.length === 0 && asymmetric === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(
      `bots failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  },
);
