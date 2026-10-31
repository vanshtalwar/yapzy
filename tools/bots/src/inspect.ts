/**
 * Redis inspection for load tests and resilience drills (Part 10):
 *   pnpm --filter @app/bots inspect -- keys              key families + stuck-state check
 *   pnpm --filter @app/bots inspect -- monitor --seconds 10   ops/s per key family (MONITOR)
 *
 * `keys` SCANs the whole DB and checks what must be empty once every client is gone and the
 * reconnect grace has passed: session refs, waiting tickets, overdue deadlines, active sessions.
 * `monitor` samples MONITOR (it costs Redis throughput, keep it short) and attributes every
 * command — including those run inside Lua scripts — to a key family, so a hot family or key
 * stands out. Reads REDIS_URL from the root .env.
 */
import { connect } from 'node:net';
import { parseArgs } from 'node:util';

import { createEnv } from '@app/env';
import { createRedis } from '@app/redis';
import { z } from 'zod';

/** Plain stdout (not a logger): this is a CLI report. */
const out = (...parts: unknown[]) =>
  process.stdout.write(
    `${parts.map((part) => (typeof part === 'string' ? part : String(part))).join(' ')}\n`,
  );

const env = createEnv(z.object({ REDIS_URL: z.url() }), { service: 'bots-inspect' });
const { values, positionals } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  allowPositionals: true,
  options: {
    seconds: { type: 'string', default: '10' },
    top: { type: 'string', default: '10' },
  },
});
const command = positionals[0] ?? 'keys';
const seconds = z.coerce.number().min(1).max(600).parse(values.seconds);
const top = z.coerce.number().int().min(1).max(100).parse(values.top);

const FAMILIES: [string, RegExp][] = [
  ['mm queue', /^\{mm:[^}]+\}:q:/],
  ['mm tickets', /^\{mm:[^}]+\}:tickets$/],
  ['mm recent pairs', /^\{mm:[^}]+\}:recent$/],
  ['visitor session ref', /^visitor:[^:]+:session$/],
  ['visitor ticket ref', /^visitor:[^:]+:ticket$/],
  ['visitor socket', /^visitor:[^:]+:socket$/],
  ['session meta', /^session:\{[^}]+\}:meta$/],
  ['session participants', /^session:\{[^}]+\}:participants$/],
  ['session log', /^session:\{[^}]+\}:log$/],
  ['session frames', /^session:\{[^}]+\}:frames$/],
  ['deadlines', /^session:deadlines:/],
  ['presence', /^presence:/],
  ['match counters', /^stats:matches:/],
  ['ban cache', /^ban:/],
  ['trust cache', /^trust:/],
  ['risk profile', /^risk:/],
  ['rate limits', /^rl:/],
  ['bullmq', /^\{bull\}:/],
  ['locks', /^lock:/],
  ['moderation budget', /^mod:/],
  ['admin sessions', /^admsess:/],
  ['report penalty', /^report:/],
];
const familyOf = (key: string) => FAMILIES.find(([, pattern]) => pattern.test(key))?.[0] ?? 'other';

const redis = createRedis(env.REDIS_URL, { connectionName: 'bots-inspect' });

async function keys(): Promise<void> {
  const counts = new Map<string, number>();
  const sessionMetas: string[] = [];
  const ticketHashes: string[] = [];
  const deadlineKeys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'COUNT', 1_000);
    cursor = next;
    for (const key of batch) {
      const family = familyOf(key);
      counts.set(family, (counts.get(family) ?? 0) + 1);
      if (family === 'session meta') sessionMetas.push(key);
      if (family === 'mm tickets') ticketHashes.push(key);
      if (family === 'deadlines') deadlineKeys.push(key);
    }
  } while (cursor !== '0');

  out('key families:');
  for (const [family, count] of [...counts].sort((a, b) => b[1] - a[1])) {
    out(`  ${family.padEnd(22)} ${String(count)}`);
  }

  let activeSessions = 0;
  for (const key of sessionMetas) {
    if ((await redis.hget(key, 'state')) === 'active') activeSessions += 1;
  }
  let waitingTickets = 0;
  for (const key of ticketHashes) {
    for (const value of await redis.hvals(key)) {
      if ((JSON.parse(value) as { status?: string }).status === 'waiting') waitingTickets += 1;
    }
  }
  let deadlines = 0;
  let overdue = 0;
  const now = Date.now();
  for (const key of deadlineKeys) {
    deadlines += await redis.zcard(key);
    overdue += await redis.zcount(key, '-inf', String(now - 5_000));
  }
  const stuck = {
    sessionRefs: counts.get('visitor session ref') ?? 0,
    ticketRefs: counts.get('visitor ticket ref') ?? 0,
    activeSessions,
    waitingTickets,
    deadlines,
    overdueDeadlines: overdue,
  };
  out('stuck-state check (all 0 once clients are gone and the grace period passed):');
  out(`  ${JSON.stringify(stuck)}`);
}

/**
 * MONITOR over a raw TCP connection: its output is plain text lines
 * (`+<time> [<db> <client>] "cmd" "arg"…`), and a dedicated socket can't interleave with other
 * commands the way a shared client connection can.
 */
function monitorLines(url: string, onLine: (args: string[]) => void): { stop: () => void } {
  const target = new URL(url);
  const socket = connect(Number(target.port || 6379), target.hostname);
  if (target.password !== '') {
    const user = target.username === '' ? '' : `${decodeURIComponent(target.username)} `;
    socket.write(`AUTH ${user}${decodeURIComponent(target.password)}\r\n`);
  }
  socket.write('MONITOR\r\n');
  let buffer = '';
  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let newline = buffer.indexOf('\r\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 2);
      const bracket = line.indexOf('] ');
      if (line.startsWith('+') && bracket !== -1) {
        const args = [...line.slice(bracket + 2).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(
          (match) => match[1] ?? '',
        );
        onLine(args);
      }
      newline = buffer.indexOf('\r\n');
    }
  });
  return { stop: () => socket.destroy() };
}

async function monitor(): Promise<void> {
  const byFamily = new Map<string, number>();
  const byKey = new Map<string, number>();
  const byCommand = new Map<string, number>();
  let total = 0;
  const watcher = monitorLines(env.REDIS_URL, (args) => {
    const name = (args[0] ?? '').toLowerCase();
    if (name === '' || name === 'monitor') return;
    total += 1;
    byCommand.set(name, (byCommand.get(name) ?? 0) + 1);
    let key: string | undefined;
    if (name === 'evalsha' || name === 'eval' || name === 'fcall') key = args[3];
    else if (name === 'publish' || name === 'spublish') key = `channel:${args[1] ?? ''}`;
    else key = args[1];
    if (key === undefined) return;
    // Socket.io adapter channels: `socket.io#/#visitor:<id>#` — one channel per room.
    const family = key.startsWith('channel:')
      ? `pubsub ${key.slice(8).split('#')[0] ?? ''}`
      : familyOf(key);
    byFamily.set(family, (byFamily.get(family) ?? 0) + 1);
    byKey.set(key, (byKey.get(key) ?? 0) + 1);
  });
  await new Promise((resolve) => setTimeout(resolve, seconds * 1_000));
  watcher.stop();

  const rate = (count: number) => (count / seconds).toFixed(1);
  out(`MONITOR ${String(seconds)} s: ${String(total)} commands (${rate(total)}/s)`);
  out('ops/s per key family:');
  for (const [family, count] of [...byFamily].sort((a, b) => b[1] - a[1])) {
    out(
      `  ${family.padEnd(26)} ${rate(count).padStart(9)}  ${((100 * count) / Math.max(1, total)).toFixed(1)} %`,
    );
  }
  out(`top ${String(top)} keys:`);
  for (const [key, count] of [...byKey].sort((a, b) => b[1] - a[1]).slice(0, top)) {
    out(`  ${rate(count).padStart(9)}/s  ${key}`);
  }
  out('commands:', JSON.stringify(Object.fromEntries([...byCommand].sort((a, b) => b[1] - a[1]))));
}

try {
  if (command === 'keys') await keys();
  else if (command === 'monitor') await monitor();
  else throw new Error(`unknown command "${command}" (keys | monitor)`);
} finally {
  redis.disconnect();
}
