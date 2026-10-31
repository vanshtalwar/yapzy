import { createHmac } from 'node:crypto';

import { banDeviceKey, banIpKey, type Redis } from '@app/redis';
import { hmacHash } from '@app/shared/crypto';
import { createVisitorTokenService } from '@app/shared/visitor-token';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { type App, BODY_LIMIT_BYTES } from './app.ts';
import { SESSION_RATE_LIMIT } from './routes/session.ts';
import { TURN_RATE_LIMIT } from './routes/turn.ts';
import {
  buildTestApp,
  createFakeClock,
  newDeviceId,
  prisma,
  randomTestIp,
  redis,
  testConfig,
} from './test/helpers.ts';

const clock = createFakeClock();
let app: App;
const createdDeviceHashes: string[] = [];

const deviceHash = (deviceId: string) => hmacHash(deviceId, testConfig.DEVICE_HASH_PEPPER);

interface SessionOk {
  token: string;
  visitorId: string;
  expiresAt: string;
}

interface ErrorBody {
  error: { code: string; message: string; requestId: string; [key: string]: unknown };
}

function postSession(
  overrides: Record<string, unknown> = {},
  options: { ip?: string; deviceId?: string } = {},
) {
  const deviceId = options.deviceId ?? newDeviceId();
  createdDeviceHashes.push(deviceHash(deviceId));
  return app.inject({
    method: 'POST',
    url: '/v1/session',
    remoteAddress: options.ip ?? randomTestIp(),
    payload: {
      turnstileToken: 'ok',
      ageConfirmed: true,
      tosVersion: testConfig.TOS_VERSION,
      deviceId,
      ...overrides,
    },
  });
}

async function startSession(): Promise<SessionOk> {
  const response = await postSession();
  expect(response.statusCode).toBe(200);
  return response.json<SessionOk>();
}

function getTurn(token?: string) {
  return app.inject({
    method: 'GET',
    url: '/v1/turn-credentials',
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
}

beforeAll(async () => {
  app = await buildTestApp({ clock });
});

beforeEach(async () => {
  await redis.flushdb();
});

afterAll(async () => {
  await prisma.ban.deleteMany({ where: { deviceIdHash: { in: createdDeviceHashes } } });
  await prisma.visitor.deleteMany({ where: { deviceIdHash: { in: createdDeviceHashes } } });
  await app.close();
  await prisma.$disconnect();
  await redis.quit();
});

describe('health & config', () => {
  it('reports liveness and readiness', async () => {
    expect((await app.inject({ url: '/health' })).json()).toEqual({ status: 'ok' });
    const ready = await app.inject({ url: '/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: 'ready', checks: { postgres: 'ok', redis: 'ok' } });
  });

  it('fails readiness when Redis is down', async () => {
    const brokenRedis = {
      ping: () => Promise.reject(new Error('connection refused')),
      defineCommand: () => undefined, // Lua scripts are registered while the app is built
    } as unknown as Redis; // only ping() is reachable with rate limiting disabled
    const devConfig = {
      ...testConfig,
      NODE_ENV: 'development' as const,
      RATE_LIMIT_DISABLED: true,
    };
    const broken = await buildTestApp({ config: devConfig, redis: brokenRedis });
    try {
      const response = await broken.inject({ url: '/ready' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        status: 'unavailable',
        checks: { postgres: 'ok', redis: 'fail' },
      });
    } finally {
      await broken.close();
    }
  });

  it('serves the public config', async () => {
    const response = await app.inject({ url: '/v1/config' });
    expect(response.json()).toEqual({
      tosVersion: 'test-tos',
      maxMessageLength: 500,
      maxInterests: 5,
      supportedLangs: expect.arrayContaining(['en']) as unknown,
      features: { video: true, reports: true },
    });
  });
});

describe('POST /v1/session', () => {
  it('issues a token and upserts the visitor by hashed device id', async () => {
    const deviceId = newDeviceId();
    const ip = '198.51.100.10';
    const first = await postSession({}, { deviceId, ip });
    expect(first.statusCode).toBe(200);
    const body = first.json<SessionOk>();
    expect(body.expiresAt).toBe('2026-10-31T13:00:00.000Z'); // clock + JWT_TTL_SECONDS

    const tokens = createVisitorTokenService({
      secret: testConfig.JWT_SECRET,
      ttlSeconds: testConfig.JWT_TTL_SECONDS,
      now: () => clock.now(),
    });
    expect((await tokens.verify(body.token)).visitorId).toBe(body.visitorId);

    const visitor = await prisma.visitor.findUniqueOrThrow({ where: { id: body.visitorId } });
    expect(visitor.deviceIdHash).toBe(deviceHash(deviceId));
    expect(visitor.lastIpHash).toBe(hmacHash(ip, testConfig.IP_HASH_PEPPER));
    expect(JSON.stringify(visitor)).not.toContain(deviceId);
    expect(visitor.tosVersion).toBe('test-tos');

    // Same device, uppercase UUID: same visitor.
    const again = await postSession({}, { deviceId: deviceId.toUpperCase() });
    expect(again.json<SessionOk>().visitorId).toBe(body.visitorId);
  });

  it('rejects a failed Turnstile check', async () => {
    const response = await postSession({ turnstileToken: 'fail' });
    expect(response.statusCode).toBe(403);
    expect(response.json<ErrorBody>().error.code).toBe('TURNSTILE_FAILED');
  });

  it('returns 503 when Turnstile is unreachable', async () => {
    const response = await postSession({ turnstileToken: 'down' });
    expect(response.statusCode).toBe(503);
    expect(response.json<ErrorBody>().error.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('rejects an outdated ToS version and a missing age confirmation', async () => {
    const tos = await postSession({ tosVersion: '2020-01' });
    expect(tos.statusCode).toBe(409);
    expect(tos.json<ErrorBody>().error).toMatchObject({
      code: 'TOS_OUTDATED',
      tosVersion: 'test-tos',
    });

    const age = await postSession({ ageConfirmed: false });
    expect(age.statusCode).toBe(400);
    expect(age.json<ErrorBody>().error.code).toBe('AGE_NOT_CONFIRMED');
  });

  it('returns the error envelope for invalid bodies', async () => {
    const response = await postSession({ deviceId: 'not-a-uuid' });
    expect(response.statusCode).toBe(400);
    const { error } = response.json<ErrorBody>();
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.requestId).toBe(response.headers['x-request-id']);
  });

  it('refuses a hard-banned device with 403 BANNED and caches the ban', async () => {
    const deviceId = newDeviceId();
    await startSessionFor(deviceId);
    const expiresAt = new Date('2026-12-01T00:00:00.000Z');
    await prisma.ban.create({
      data: { deviceIdHash: deviceHash(deviceId), type: 'HARD', reason: 'test', expiresAt },
    });
    await redis.flushdb(); // drop the "not banned" entry cached by the first session

    const response = await postSession({}, { deviceId });
    expect(response.statusCode).toBe(403);
    expect(response.json<ErrorBody>().error).toMatchObject({
      code: 'BANNED',
      expiresAt: expiresAt.toISOString(),
    });
    const cached = await redis.get(banDeviceKey(deviceHash(deviceId)));
    expect(JSON.parse(cached ?? '{}')).toMatchObject({ banned: true, type: 'HARD' });
  });

  it('refuses a hard-banned IP but lets shadow-banned devices in silently', async () => {
    const ip = '198.51.100.66';
    await prisma.ban.create({
      data: { ipHash: hmacHash(ip, testConfig.IP_HASH_PEPPER), type: 'HARD', reason: 'test' },
    });
    try {
      const byIp = await postSession({}, { ip });
      expect(byIp.statusCode).toBe(403);
      expect(byIp.json<ErrorBody>().error).toMatchObject({ code: 'BANNED', expiresAt: null });
    } finally {
      await prisma.ban.deleteMany({ where: { ipHash: hmacHash(ip, testConfig.IP_HASH_PEPPER) } });
    }

    const shadowDevice = newDeviceId();
    await prisma.ban.create({
      data: { deviceIdHash: deviceHash(shadowDevice), type: 'SHADOW', reason: 'test' },
    });
    createdDeviceHashes.push(deviceHash(shadowDevice));
    expect((await postSession({}, { deviceId: shadowDevice })).statusCode).toBe(200);
  });

  it('caches "not banned" so repeat visits skip Postgres', async () => {
    const deviceId = newDeviceId();
    const ip = '198.51.100.20';
    await postSession({}, { deviceId, ip });
    const cached = await redis.get(banIpKey(hmacHash(ip, testConfig.IP_HASH_PEPPER)));
    expect(JSON.parse(cached ?? '{}')).toEqual({ banned: false });
    expect(await redis.ttl(banDeviceKey(deviceHash(deviceId)))).toBeGreaterThan(0);
  });

  it('rate limits per IP even though RATE_LIMIT_DISABLED=true outside development', async () => {
    const ip = '198.51.100.99';
    for (let i = 0; i < SESSION_RATE_LIMIT.max; i += 1) {
      expect((await postSession({}, { ip })).statusCode).toBe(200);
    }
    const limited = await postSession({}, { ip });
    expect(limited.statusCode).toBe(429);
    expect(limited.json<ErrorBody>().error.code).toBe('RATE_LIMITED');
    expect(limited.headers['retry-after']).toBeDefined();
    // Another IP is unaffected.
    expect((await postSession({}, { ip: '198.51.100.98' })).statusCode).toBe(200);
  });

  async function startSessionFor(deviceId: string): Promise<SessionOk> {
    const response = await postSession({}, { deviceId });
    expect(response.statusCode).toBe(200);
    return response.json<SessionOk>();
  }
});

describe('GET /v1/turn-credentials', () => {
  it('returns coturn REST credentials (HMAC-SHA1 over "<expiry>:<visitorId>")', async () => {
    const { token, visitorId } = await startSession();
    const response = await getTurn(token);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');

    const body = response.json<{
      iceServers: { urls: string[]; username?: string; credential?: string }[];
      ttlSeconds: number;
    }>();
    const expectedExpiry = Math.floor(clock.now().getTime() / 1000) + 600;
    const expectedUsername = `${String(expectedExpiry)}:${visitorId}`;
    expect(body).toEqual({
      ttlSeconds: 600,
      iceServers: [
        { urls: ['stun:stun.test:3478'] },
        {
          urls: ['turn:turn.test:3478?transport=udp', 'turn:turn.test:3478?transport=tcp'],
          username: expectedUsername,
          credential: createHmac('sha1', testConfig.TURN_SECRET)
            .update(expectedUsername)
            .digest('base64'),
        },
      ],
    });
  });

  it('distinguishes missing, tampered and expired tokens', async () => {
    const missing = await getTurn();
    expect(missing.statusCode).toBe(401);
    expect(missing.json<ErrorBody>().error.code).toBe('UNAUTHORIZED');

    const { token } = await startSession();
    const tampered = `${token.slice(0, -4)}${token.endsWith('AAAA') ? 'BBBB' : 'AAAA'}`;
    expect((await getTurn(tampered)).json<ErrorBody>().error.code).toBe('TOKEN_INVALID');
    expect((await getTurn('not.a-jwt')).json<ErrorBody>().error.code).toBe('TOKEN_INVALID');

    clock.advance((testConfig.JWT_TTL_SECONDS + 1) * 1000);
    try {
      const expired = await getTurn(token);
      expect(expired.statusCode).toBe(401);
      expect(expired.json<ErrorBody>().error.code).toBe('TOKEN_EXPIRED');
    } finally {
      clock.advance(-(testConfig.JWT_TTL_SECONDS + 1) * 1000);
    }
  });

  it('rate limits per visitor', async () => {
    const { token } = await startSession();
    for (let i = 0; i < TURN_RATE_LIMIT.max; i += 1) {
      expect((await getTurn(token)).statusCode).toBe(200);
    }
    expect((await getTurn(token)).statusCode).toBe(429);
    const other = await startSession();
    expect((await getTurn(other.token)).statusCode).toBe(200);
  });
});

describe('cross-cutting behaviour', () => {
  it('allows CORS only for configured origins', async () => {
    const preflight = (origin: string) =>
      app.inject({
        method: 'OPTIONS',
        url: '/v1/session',
        headers: {
          origin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      });

    const allowed = await preflight('http://localhost:3000');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3000');

    const rejected = await preflight('https://evil.example');
    expect(rejected.headers['access-control-allow-origin']).toBeUndefined();

    const simple = await app.inject({
      url: '/v1/config',
      headers: { origin: 'https://evil.example' },
    });
    expect(simple.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('returns the envelope for unknown routes and oversized bodies', async () => {
    const notFound = await app.inject({ url: '/nope' });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json<ErrorBody>().error.code).toBe('NOT_FOUND');

    const tooLarge = await app.inject({
      method: 'POST',
      url: '/v1/session',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ padding: 'x'.repeat(BODY_LIMIT_BYTES) }),
    });
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json<ErrorBody>().error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('sets security headers', async () => {
    const response = await app.inject({ url: '/health' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sums online counts from live gateway nodes and caches for 2 s', async () => {
    const statsClock = createFakeClock();
    const statsApp = await buildTestApp({ clock: statsClock });
    try {
      await redis.sadd('presence:nodes', 'gw-a', 'gw-b', 'gw-dead');
      await redis.set('presence:node:gw-a', '3');
      await redis.set('presence:node:gw-b', '4');
      const read = async () =>
        (await statsApp.inject({ url: '/v1/stats/online' })).json<{ online: number }>().online;

      expect(await read()).toBe(7);
      await redis.set('presence:node:gw-a', '10');
      expect(await read()).toBe(7); // cached
      statsClock.advance(2_001);
      expect(await read()).toBe(14);
    } finally {
      await statsApp.close();
    }
  });
});
