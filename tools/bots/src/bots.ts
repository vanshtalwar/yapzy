/**
 * Load/functional bots:
 *   pnpm bots -- --clients 50 --gateways http://localhost:4001,http://localhost:4011 \
 *                --mode text --duration 120 --ghost-rate 0.1 --reconnect-rate 0.1
 *
 * Each bot starts a real session through the API, connects to a random gateway, queues with
 * random interests (auto-requeue on), acks its match, chats a little, then skips or ends, and
 * repeats. Ghost bots (`--ghost-rate`) never ack. Reconnect bots (`--reconnect-rate`) drop
 * their socket mid-session, reconnect to ANOTHER gateway and resume. Any bot whose gateway
 * restarts reconnects elsewhere and resumes/requeues. The summary checks symmetry, delivery,
 * resumes and ghost-session end times; exit code 1 if anything was wrong.
 *
 * More than 10 clients need the API's session rate limit off: run the API with
 * RATE_LIMIT_DISABLED=true (honoured only in development).
 */
import { randomInt } from 'node:crypto';
import { parseArgs } from 'node:util';

import { createEnv } from '@app/env';
import {
  type ClientToServerEvents,
  type MatchFound,
  type ServerToClientEvents,
  type SessionResumed,
} from '@app/shared';
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
    'ghost-rate': { type: 'string', default: '0' },
    'reconnect-rate': { type: 'string', default: '0' },
    'ack-timeout': { type: 'string', default: '5000' },
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
    'ghost-rate': z.coerce.number().min(0).max(1),
    'reconnect-rate': z.coerce.number().min(0).max(1),
    'ack-timeout': z.coerce.number().int().min(500),
  })
  .parse(values);

const INTEREST_POOL = ['music', 'games', 'movies', 'travel', 'tech', 'books'];
/** Ack failures that are legitimate races (peer left while we acted), not protocol errors. */
const BENIGN_RACE_CODES = new Set(['NOT_IN_SESSION', 'INVALID_STATE']);
const ACK_TIMEOUT_MS = 5_000;
/** A bot waiting this long without a match counts as stalled (50 bots match in ms). */
const STALL_MS = 20_000;

const stats = {
  matches: 0,
  messagesSent: 0,
  messagesReceived: 0,
  messagesLate: 0,
  messagesRecovered: 0,
  skips: 0,
  ends: 0,
  races: 0,
  voluntaryReconnects: 0,
  forcedReconnects: 0,
  resumes: 0,
  resumesRaced: 0,
  ghostSessionsEnded: [] as number[],
  protocolErrors: [] as string[],
  timeToMatchMs: [] as number[],
};
/** sessionId → what each side was told in match:found. */
const sessions = new Map<string, { selfPid: string; peerPid: string; initiator: boolean }[]>();
/** Sessions in which at least one side is a ghost (never acks). */
const ghostSessions = new Set<string>();
/** Participant ids of ghost bots (test oracle: the innocent peer waits instead of chatting). */
const ghostPids = new Set<string>();
/** Sessions a bot ended itself (chat:next / chat:end acknowledged): test oracle for races. */
const endedByABot = new Set<string>();
/** Every acknowledged message id until some bot receives it (live, late or on resume). */
const undelivered = new Map<string, { sessionId: string; sender: number; at: number }>();

let stopping = false;
/** Read through a function: `stopping` flips while bots are awaiting. */
const isStopping = () => stopping;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const pick = <T>(items: readonly T[]): T => items[randomInt(0, items.length)] as T;

function protocolError(bot: number, what: string): void {
  stats.protocolErrors.push(`bot ${String(bot)}: ${what}`);
}

function connect(url: string, token: string): Promise<BotSocket> {
  const socket: BotSocket = io(url, {
    transports: ['websocket'],
    auth: { token },
    reconnection: false,
  });
  return new Promise((resolve, reject) => {
    socket.once('connect', () => {
      resolve(socket);
    });
    socket.once('connect_error', (error) => {
      socket.close();
      reject(error);
    });
  });
}

interface Session {
  sessionId: string;
  selfPid: string;
  peerPid: string;
  matchedAt: number;
  lastMessageId?: string;
}

class Bot {
  private readonly id: number;
  private readonly token: string;
  private readonly ghost: boolean;
  private readonly reconnector: boolean;
  private socket: BotSocket;
  private gateway: string;
  private phase: 'idle' | 'joining' | 'waiting' | 'in_session' | 'offline' = 'idle';
  private session: Session | null = null;
  private readonly pastSessions = new Set<string>();
  private peerAway = false;
  private joinedAt = 0;

  constructor(id: number, token: string, socket: BotSocket, gateway: string) {
    this.id = id;
    this.token = token;
    this.socket = socket;
    this.gateway = gateway;
    this.ghost = Math.random() < args['ghost-rate'];
    this.reconnector = !this.ghost && Math.random() < args['reconnect-rate'];
    this.attach(socket);
  }

  /** Read through methods: event handlers change these while we await. */
  private currentPhase(): Bot['phase'] {
    return this.phase;
  }

  private currentSession(): Session | null {
    return this.session;
  }

  private attach(socket: BotSocket): void {
    socket.on('match:found', (match) => {
      this.onMatch(match);
    });
    socket.on('queue:waiting', () => {
      const phase = this.currentPhase();
      if (phase === 'joining' || phase === 'idle') this.phase = 'waiting';
    });
    socket.on('peer:reconnecting', (event) => {
      if (event.sessionId === this.session?.sessionId) this.peerAway = true;
    });
    socket.on('peer:resumed', (event) => {
      if (event.sessionId === this.session?.sessionId) this.peerAway = false;
    });
    socket.on('peer:left', (left) => {
      if (left.sessionId !== this.session?.sessionId) return; // stale, ignore
      if (ghostSessions.has(left.sessionId) && !this.ghost) {
        stats.ghostSessionsEnded.push(performance.now() - this.session.matchedAt);
      }
      if (left.sessionEnded) this.becomeIdle();
    });
    socket.on('chat:message', (message) => {
      undelivered.delete(message.id);
      if (message.sessionId !== this.session?.sessionId) {
        if (this.pastSessions.has(message.sessionId)) stats.messagesLate += 1;
        else protocolError(this.id, 'chat:message for a session this bot was never in');
        return;
      }
      if (message.from !== this.session.peerPid) protocolError(this.id, 'misrouted chat:message');
      this.session.lastMessageId = message.id;
      stats.messagesReceived += 1;
    });
    socket.on('system:notice', (notice) => {
      if (notice.code === 'SERVER_RESTARTING') void this.reconnect('forced');
      else protocolError(this.id, `notice ${notice.code}`);
    });
    socket.on('disconnect', (reason) => {
      // Our own disconnect() calls are handled by reconnect(); anything else is the server.
      if (!stopping && this.currentPhase() !== 'offline' && reason !== 'io client disconnect') {
        void this.reconnect('forced');
      }
    });
  }

  private async call(event: keyof ClientToServerEvents, payload: object): Promise<unknown> {
    try {
      const response = (await this.socket
        .timeout(ACK_TIMEOUT_MS)
        .emitWithAck(event, payload as never)) as {
        ok: boolean;
        data?: unknown;
        error?: { code: string };
      };
      if (response.ok) return response.data ?? true;
      const code = response.error?.code ?? 'UNKNOWN';
      if (BENIGN_RACE_CODES.has(code)) stats.races += 1;
      else protocolError(this.id, `${event} → ${code}`);
      return null;
    } catch {
      if (!stopping && this.currentPhase() !== 'offline') {
        protocolError(this.id, `${event} ack timeout`);
      }
      return null;
    }
  }

  private becomeIdle(): void {
    if (this.session !== null) this.pastSessions.add(this.session.sessionId);
    this.session = null;
    this.peerAway = false;
    this.phase = 'idle';
    void sleep(randomInt(50, 300)).then(() => this.join());
  }

  async join(): Promise<void> {
    if (stopping || this.phase !== 'idle') return;
    this.phase = 'joining';
    this.joinedAt = performance.now();
    const interests = Array.from({ length: randomInt(0, 3) }, () => pick(INTEREST_POOL));
    const joinedAt = this.joinedAt;
    await this.call('queue:join', {
      mode: args.mode,
      lang: args.lang,
      interests,
      autoRequeue: true,
    });
    // INVALID_STATE here usually means the server already requeued us (fair requeue).
    if (this.currentPhase() === 'joining') this.phase = 'waiting';
    void sleep(STALL_MS).then(() => {
      if (this.currentPhase() === 'waiting' && this.joinedAt === joinedAt && !stopping) {
        protocolError(this.id, 'stalled while waiting');
      }
    });
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
    if (this.session !== null) this.pastSessions.add(this.session.sessionId);
    this.session = {
      sessionId: match.sessionId,
      selfPid: record.selfPid,
      peerPid: record.peerPid,
      matchedAt: performance.now(),
    };
    this.pastSessions.add(match.sessionId);
    this.peerAway = false;
    this.phase = 'in_session';

    if (this.ghost) {
      // Never ack; once the server has timed us out, look for the next victim.
      ghostSessions.add(match.sessionId);
      ghostPids.add(match.selfParticipantId);
      void sleep(args['ack-timeout'] + 1_500).then(() => {
        if (this.session?.sessionId === match.sessionId) this.becomeIdle();
      });
      return;
    }
    void this.call('match:ack', { sessionId: match.sessionId }).then(() =>
      this.converse(match.sessionId),
    );
  }

  private async waitWhilePeerAway(sessionId: string): Promise<boolean> {
    while (this.peerAway && this.session?.sessionId === sessionId && !stopping) await sleep(100);
    return this.session?.sessionId === sessionId && !stopping;
  }

  private async converse(sessionId: string): Promise<void> {
    await sleep(50); // let the peer's match:found land so the ghost oracle is populated
    const current = this.currentSession();
    if (current !== null && ghostPids.has(current.peerPid)) {
      // Like a person waiting for a stranger who never shows: do nothing until the server
      // ends the session (ack timeout); peer:left then makes us idle.
      await sleep(args['ack-timeout'] + 3_000);
      if (this.currentSession()?.sessionId === sessionId && !isStopping()) {
        protocolError(this.id, 'ghost session was not ended by the ack timeout');
      }
      return;
    }
    const messages = randomInt(1, 4);
    for (let i = 0; i < messages; i += 1) {
      // Human-ish pacing: the per-socket rate limit (5 tokens/s) stops faster clients.
      await sleep(randomInt(300, 800));
      if (!(await this.waitWhilePeerAway(sessionId))) return;
      if (this.currentPhase() !== 'in_session') return;
      const sent = await this.call('chat:message', {
        sessionId,
        text: `hello #${String(i)}`,
        clientMsgId: `m${String(i)}`,
      });
      if (sent !== null) {
        stats.messagesSent += 1;
        const { id } = sent as { id: string };
        undelivered.set(id, { sessionId, sender: this.id, at: performance.now() });
      }
      if (i === 0 && this.reconnector && randomInt(0, 2) === 0) {
        await this.reconnect('voluntary');
        if (this.session?.sessionId !== sessionId) return;
      }
    }
    await sleep(randomInt(500, 1_500));
    if (!(await this.waitWhilePeerAway(sessionId))) return;
    if (this.currentPhase() !== 'in_session') return;

    if (randomInt(0, 2) === 0) {
      stats.skips += 1;
      this.pastSessions.add(sessionId);
      this.session = null;
      this.phase = 'joining';
      this.joinedAt = performance.now();
      const ok = await this.call('chat:next', { sessionId });
      if (ok !== null) endedByABot.add(sessionId);
      if (this.currentPhase() === 'joining') this.phase = ok !== null ? 'waiting' : 'idle';
      if (ok === null && this.currentPhase() === 'idle') this.becomeIdle();
    } else {
      stats.ends += 1;
      this.pastSessions.add(sessionId);
      this.session = null;
      this.phase = 'joining'; // block peer:left re-joins until our own end is acknowledged
      if ((await this.call('chat:end', { sessionId })) !== null) endedByABot.add(sessionId);
      if (this.currentPhase() === 'joining') this.becomeIdle();
    }
  }

  /**
   * Drop the socket and come back on another gateway: resume the session if we had one,
   * otherwise requeue. `forced` = the server went away (restart), `voluntary` = test churn.
   */
  private async reconnect(kind: 'forced' | 'voluntary'): Promise<void> {
    if (this.currentPhase() === 'offline' || stopping) return;
    const before = this.phase;
    this.phase = 'offline';
    if (kind === 'voluntary') stats.voluntaryReconnects += 1;
    else stats.forcedReconnects += 1;
    // Snapshot what we had BEFORE going away: a message that arrives live on the new socket
    // must not advance the resume cursor past ones we missed while offline.
    const resumeFrom = this.session?.lastMessageId;
    this.socket.removeAllListeners();
    this.socket.disconnect();

    const others = args.gateways.filter((url) => url !== this.gateway);
    for (let attempt = 0; attempt < 50 && !isStopping(); attempt += 1) {
      const url = attempt === 0 && others.length > 0 ? pick(others) : pick(args.gateways);
      try {
        this.socket = await connect(url, this.token);
        this.gateway = url;
        break;
      } catch {
        await sleep(200); // the restarted node may be down for a while
      }
    }
    if (isStopping()) return;
    this.attach(this.socket);

    const session = this.session;
    if (session === null || before !== 'in_session') {
      this.phase = 'idle'; // a waiting ticket is dropped on disconnect: queue again
      await this.join();
      return;
    }
    this.phase = 'in_session';
    const response = (await this.socket
      .timeout(ACK_TIMEOUT_MS)
      .emitWithAck('session:resume', {
        sessionId: session.sessionId,
        ...(resumeFrom === undefined ? {} : { lastMessageId: resumeFrom }),
      })
      .catch(() => null)) as {
      ok: boolean;
      data?: SessionResumed;
      error?: { code: string };
    } | null;
    const resumed = response?.ok === true ? (response.data ?? null) : null;
    if (resumed === null) {
      // Legitimate only if the session really ended meanwhile: the peer skipped/ended it, or
      // the peer was a ghost whose ack deadline fired. Anything else is a protocol error.
      if (endedByABot.has(session.sessionId) || ghostPids.has(session.peerPid)) {
        stats.resumesRaced += 1;
      } else {
        protocolError(
          this.id,
          `resume of ${session.sessionId} failed: ${response?.error?.code ?? 'ack timeout'}`,
        );
      }
      if (this.currentSession()?.sessionId === session.sessionId) this.becomeIdle();
      return;
    }
    stats.resumes += 1;
    for (const message of resumed.missedMessages) {
      if (!undelivered.has(message.id)) continue; // already received live: dedupe by id
      undelivered.delete(message.id);
      if (message.from === session.peerPid) stats.messagesRecovered += 1;
    }
    if (!this.ghost && kind === 'forced') void this.converse(session.sessionId);
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
    `starting ${String(args.clients)} bots (${args.mode}, ${args.lang}) for ${String(args.duration)} s, ` +
      `ghost-rate ${String(args['ghost-rate'])}, reconnect-rate ${String(args['reconnect-rate'])}`,
  );

  const bots: Bot[] = [];
  for (let i = 0; i < args.clients; i += 1) {
    const { token } = await startSession(args.api);
    const gateway = pick(args.gateways);
    bots.push(new Bot(i + 1, token, await connect(gateway, token), gateway));
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
  const ghostEnds = [...stats.ghostSessionsEnded].sort((a, b) => a - b);
  const n = (value: number) => String(value);
  out('');
  out('── bot run summary ─────────────────────────────');
  out(
    `sessions            ${n(sessions.size)} (asymmetric: ${n(asymmetric)}, with a ghost: ${n(ghostSessions.size)})`,
  );
  out(`match:found events  ${n(stats.matches)}`);
  out(
    `messages            sent ${n(stats.messagesSent)}, received live ${n(stats.messagesReceived)}, ` +
      `recovered on resume ${n(stats.messagesRecovered)}, after receiver moved on ${n(stats.messagesLate)}`,
  );
  out(`undelivered         ${n(undelivered.size)} acknowledged messages never reached a bot`);
  for (const [id, info] of [...undelivered].slice(0, 5)) {
    out(`  ${id} session ${info.sessionId} from bot ${n(info.sender)}`);
  }
  out(`skips / ends        ${n(stats.skips)} / ${n(stats.ends)}`);
  out(
    `reconnects          voluntary ${n(stats.voluntaryReconnects)}, forced ${n(stats.forcedReconnects)}; ` +
      `sessions resumed ${n(stats.resumes)}, not resumable because the session had ended ${n(stats.resumesRaced)}`,
  );
  out(
    `ghost sessions      ended for the waiting peer after p50 ${percentile(ghostEnds, 50).toFixed(0)} ms, ` +
      `max ${(ghostEnds.at(-1) ?? 0).toFixed(0)} ms (ack timeout ${n(args['ack-timeout'])} ms)`,
  );
  out(`benign races        ${n(stats.races)} (NOT_IN_SESSION / INVALID_STATE)`);
  out(
    `time to match       p50 ${percentile(ttm, 50).toFixed(0)} ms, p95 ${percentile(ttm, 95).toFixed(0)} ms`,
  );
  out(`protocol errors     ${n(stats.protocolErrors.length)}`);
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
