import { randomUUID } from 'node:crypto';

import { createPrismaClient } from '@app/db';
import { createEnv, databaseTestEnv, type GatewayEnv, gatewayEnv, redisTestEnv } from '@app/env';
import { createLogger, type Logger } from '@app/logger';
import { createRedis } from '@app/redis';
import { createVisitorTokenService } from '@app/shared/visitor-token';
import { io as connectClient, type Socket as ClientSocket } from 'socket.io-client';

import { createGateway, type Gateway } from '../gateway.ts';

const { DATABASE_URL_TEST } = createEnv(databaseTestEnv, { service: 'gateway-tests' });
const { REDIS_URL_TEST } = createEnv(redisTestEnv, { service: 'gateway-tests' });

/** App data lives in DB 13 (other packages' tests flush 12, 14 and 15 in parallel). */
const appRedisUrl = (() => {
  const url = new URL(REDIS_URL_TEST);
  url.pathname = '/13';
  return url.toString();
})();

export const ALLOWED_ORIGIN = 'http://localhost:3000';
const JWT_SECRET = 'gateway-test-jwt-secret-0123456789abcdef';

const testSource = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: DATABASE_URL_TEST,
  REDIS_URL: REDIS_URL_TEST,
  IP_HASH_PEPPER: 'gateway-test-ip-pepper',
  JWT_SECRET,
  CORS_ORIGINS: ALLOWED_ORIGIN,
  // One bucket by default keeps session tests deterministic; text:zh exercises buckets.
  MM_BUCKETS: '1',
  MM_BUCKETS_BY_QUEUE: '{"text:zh": 4}',
  MATCH_ACK_TIMEOUT_MS: '1000',
  RECONNECT_GRACE_MS: '1500',
  EARLY_FAILURE_WINDOW_MS: '10000',
  // All test sockets share 127.0.0.1; the limits themselves are tested with low values.
  HANDSHAKE_LIMIT_PER_VISITOR: '1000',
  HANDSHAKE_LIMIT_PER_IP: '1000000',
};

export const testConfig = createEnv(gatewayEnv, { service: 'gateway-tests', source: testSource });

/** The test configuration with some variables changed (raw env strings, validated again). */
export function testConfigWith(overrides: Record<string, string>): GatewayEnv {
  return createEnv(gatewayEnv, {
    service: 'gateway-tests',
    source: { ...testSource, ...overrides },
  });
}

export const prisma = createPrismaClient({ databaseUrl: DATABASE_URL_TEST, maxConnections: 4 });
export const appRedis = createRedis(appRedisUrl, { connectionName: 'gateway-tests' });

// Unique per run: Redis pub/sub channels are global (not per DB), so a dev gateway running
// on this machine must never see test traffic, and vice versa.
const runId = randomUUID().slice(0, 8);
export const CONTROL_CHANNEL = `test:gw:control:${runId}`;

export function startGateway(
  name: string,
  options: {
    drainTimeoutMs?: number;
    interestFallbackMs?: number;
    config?: GatewayEnv;
    logger?: Logger;
  } = {},
) {
  return (async (): Promise<{ gateway: Gateway; port: number; url: string }> => {
    const gateway = await createGateway({
      config: options.config ?? testConfig,
      nodeId: `test-${name}-${runId}`,
      prisma,
      logger: options.logger ?? createLogger({ service: 'gateway-test', level: 'silent' }),
      redisUrl: appRedisUrl,
      options: {
        controlChannel: CONTROL_CHANNEL,
        adapterChannelPrefix: `test-io-${runId}`,
        presenceIntervalMs: 200,
        drainTimeoutMs: options.drainTimeoutMs ?? 300,
        interestFallbackMs: options.interestFallbackMs ?? 300,
        deadlineIntervalMs: 100,
      },
    });
    const port = await gateway.listen(0, '127.0.0.1');
    return { gateway, port, url: `http://127.0.0.1:${String(port)}` };
  })();
}

export function tokenFor(visitorId: string, issuedAt = new Date()): Promise<string> {
  const service = createVisitorTokenService({
    secret: JWT_SECRET,
    ttlSeconds: 3600,
    now: () => issuedAt,
  });
  return service.issue(visitorId).then(({ token }) => token);
}

export function connect(
  url: string,
  options: { token?: string; origin?: string; headers?: Record<string, string> } = {},
): ClientSocket {
  return connectClient(url, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    auth: options.token === undefined ? {} : { token: options.token },
    extraHeaders: { origin: options.origin ?? ALLOWED_ORIGIN, ...options.headers },
  });
}

export interface ConnectFailure {
  message: string;
  data?: { code?: string; [key: string]: unknown };
}

/** Resolves 'connected' or the connect_error the server sent. */
export function connectOutcome(socket: ClientSocket): Promise<'connected' | ConnectFailure> {
  return new Promise((resolve) => {
    socket.once('connect', () => {
      resolve('connected');
    });
    socket.once('connect_error', (error: Error & { data?: ConnectFailure['data'] }) => {
      resolve({ message: error.message, data: error.data });
    });
  });
}

export async function connected(url: string, token: string): Promise<ClientSocket> {
  const socket = connect(url, { token });
  const outcome = await connectOutcome(socket);
  if (outcome !== 'connected') throw new Error(`connect failed: ${outcome.message}`);
  return socket;
}

export function nextEvent<T>(socket: ClientSocket, event: string, timeoutMs = 3_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out waiting for ${event}`));
    }, timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

export const newVisitorId = () => randomUUID();
