import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createConnection } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The services the tests talk to, on the usual development ports. */
export const URLS = {
  web: 'http://localhost:3000',
  admin: 'http://localhost:3001',
  api: 'http://localhost:4000',
  gateway: 'http://localhost:4001',
  worker: 'http://localhost:4002',
} as const;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STATE_FILE = path.join(ROOT, 'e2e/.stack.json');
const LOG_DIR = path.join(ROOT, 'e2e/test-results/stack');

/**
 * Overrides for the Node services (the rest comes from the root .env): no session/handshake
 * rate limits (every test visitor shares 127.0.0.1; honoured only with NODE_ENV=development),
 * one queue bucket (deterministic matching), a short match-ack timeout (ghost test) and group
 * calls open to new visitors (trust 50).
 */
const SERVICE_ENV: Record<string, string> = {
  RATE_LIMIT_DISABLED: 'true',
  HANDSHAKE_LIMIT_PER_IP: '1000000',
  MM_BUCKETS: '1',
  MATCH_ACK_TIMEOUT_MS: '3000',
  GROUP_MIN_TRUST: '50',
  LOG_LEVEL: 'warn',
};

interface ServiceSpec {
  name: string;
  cwd: string;
  args: string[];
  port: number;
  ready: string;
  env?: Record<string, string>;
}

const nextBin = createRequire(path.join(ROOT, 'apps/web/package.json')).resolve(
  'next/dist/bin/next',
);

export const SERVICES: ServiceSpec[] = [
  {
    name: 'api',
    cwd: 'apps/api',
    args: ['dist/server.js'],
    port: 4000,
    ready: `${URLS.api}/ready`,
    env: SERVICE_ENV,
  },
  {
    name: 'gateway',
    cwd: 'apps/gateway',
    args: ['dist/server.js'],
    port: 4001,
    ready: `${URLS.gateway}/ready`,
    env: SERVICE_ENV,
  },
  {
    name: 'worker',
    cwd: 'apps/worker',
    args: ['dist/server.js'],
    port: 4002,
    ready: `${URLS.worker}/health`,
    env: SERVICE_ENV,
  },
  {
    name: 'web',
    cwd: 'apps/web',
    args: [nextBin, 'start', '-p', '3000'],
    port: 3000,
    ready: `${URLS.web}/`,
  },
  {
    name: 'admin',
    cwd: 'apps/admin',
    args: [nextBin, 'start', '-p', '3001'],
    port: 3001,
    ready: `${URLS.admin}/login`,
  },
];

export interface StackState {
  /** false = E2E_REUSE_STACK: the tests must not stop or restart anything. */
  owned: boolean;
  pids: Record<string, number>;
  admin: { email: string; password: string };
  /** One API session for all tests: admin logins are limited to 5 per minute per email. */
  adminSession: { cookie: string; csrfToken: string };
}

export const readState = (): StackState =>
  JSON.parse(readFileSync(STATE_FILE, 'utf8')) as StackState;
const writeState = (state: StackState) => {
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
};

export function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      resolve(false);
    });
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitForUrl(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`${url} did not become ready`);
    await sleep(500);
  }
}

function start(spec: ServiceSpec): number {
  mkdirSync(LOG_DIR, { recursive: true });
  const log = openSync(path.join(LOG_DIR, `${spec.name}.log`), 'a');
  const child = spawn(process.execPath, spec.args, {
    cwd: path.join(ROOT, spec.cwd),
    env: { ...process.env, ...spec.env },
    // Own process group, so stopping it also stops anything it spawned.
    detached: true,
    stdio: ['ignore', log, log],
  });
  closeSync(log);
  child.unref();
  if (child.pid === undefined) throw new Error(`could not start ${spec.name}`);
  return child.pid;
}

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(-pid, name);
  } catch {
    try {
      process.kill(pid, name);
    } catch {
      // already gone
    }
  }
}

async function stop(pid: number, port: number): Promise<void> {
  signal(pid, 'SIGTERM');
  // The gateway drains for up to 10 s (SERVER_RESTARTING → clients reconnect elsewhere).
  for (let i = 0; i < 60 && (await portInUse(port)); i += 1) await sleep(250);
  if (await portInUse(port)) signal(pid, 'SIGKILL');
}

/** Global setup: start every service (or check a running stack) and a test admin. */
export async function startStack(): Promise<void> {
  const reuse = process.env.E2E_REUSE_STACK === '1';
  const busy = [];
  for (const spec of SERVICES)
    if (await portInUse(spec.port)) busy.push(`${spec.name} (${String(spec.port)})`);
  if (!reuse && busy.length > 0) {
    throw new Error(
      `Ports in use: ${busy.join(', ')}. Stop the dev servers, or set E2E_REUSE_STACK=1 to test ` +
        'the running stack (the gateway-restart test is then skipped).',
    );
  }
  const pids: Record<string, number> = {};
  if (!reuse) for (const spec of SERVICES) pids[spec.name] = start(spec);
  await Promise.all(SERVICES.map((spec) => waitForUrl(spec.ready)));

  // An ADMIN without TOTP for the admin tests (upsert; works on any database).
  const admin = {
    email: 'e2e-admin@randomchat.local',
    password: randomBytes(18).toString('base64url'),
  };
  const created = spawnSync('pnpm', ['--filter', '@app/db', 'admin:create'], {
    cwd: ROOT,
    env: {
      ...process.env,
      ADMIN_EMAIL: admin.email,
      ADMIN_PASSWORD: admin.password,
      ADMIN_ROLE: 'ADMIN',
    },
    encoding: 'utf8',
  });
  if (created.status !== 0) throw new Error(`admin:create failed: ${created.stderr}`);
  const login = await fetch(`${URLS.api}/v1/admin/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(admin),
  });
  if (!login.ok) throw new Error(`admin login failed: ${String(login.status)}`);
  const { csrfToken } = (await login.json()) as { csrfToken: string };
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  writeState({ owned: !reuse, pids, admin, adminSession: { cookie, csrfToken } });
}

export async function stopStack(): Promise<void> {
  const state = readState();
  if (!state.owned) return;
  await Promise.all(
    SERVICES.flatMap((spec) => {
      const pid = state.pids[spec.name];
      return pid === undefined ? [] : [stop(pid, spec.port)];
    }),
  );
}

/**
 * Graceful gateway restart (like a deploy): sessions must survive it (D-046). `env` adds
 * variables for the new process (e.g. DEV_FORCE_SFU); restart without it to go back.
 */
export async function restartGateway(env: Record<string, string> = {}): Promise<void> {
  const state = readState();
  const spec = SERVICES.find((service) => service.name === 'gateway');
  const pid = state.pids.gateway;
  if (!state.owned || spec === undefined || pid === undefined) {
    throw new Error('restartGateway needs the stack started by the tests');
  }
  await stop(pid, spec.port);
  state.pids.gateway = start({ ...spec, env: { ...spec.env, ...env } });
  writeState(state);
  await waitForUrl(spec.ready);
}

/** Did the tests start the stack (gateway restarts possible)? */
export const ownsStack = (): boolean => readState().owned;
