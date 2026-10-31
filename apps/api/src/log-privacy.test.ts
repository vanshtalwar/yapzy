import { randomUUID } from 'node:crypto';

import { createCapturingLogger, findSecrets } from '@app/logger/testing';
import { sessionKeys, visitorSessionKey } from '@app/redis';
import { hash } from '@node-rs/argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type App } from './app.ts';
import { buildTestApp, prisma, redis, testConfig } from './test/helpers.ts';

/**
 * Integration run with a trace-level logger: the log output must not contain tokens, raw IPs,
 * device ids, passwords, TURN credentials, cookies, CSRF tokens or user-written text.
 */
const logs = createCapturingLogger('api-log-privacy');
const RAW_IP = '203.0.113.77';
const DEVICE_ID = randomUUID();
const PASSWORD = 'log-privacy password 9f3c';
const WRONG_PASSWORD = 'wrong password 51ab';
const REPORT_TEXT = 'LOG-PRIVACY report details 7d1e';
const CHAT_TEXT = 'LOG-PRIVACY transcript line 3c9a';
let app: App;
let adminId = '';
const visitorIds: string[] = [];

async function newSession(deviceId: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/session',
    remoteAddress: RAW_IP,
    payload: {
      turnstileToken: 'ok',
      ageConfirmed: true,
      tosVersion: testConfig.TOS_VERSION,
      deviceId,
    },
  });
  expect(response.statusCode).toBe(200);
  const body = response.json<{ token: string; visitorId: string }>();
  visitorIds.push(body.visitorId);
  return body;
}

beforeAll(async () => {
  await redis.flushdb(); // rate-limit counters of earlier runs (fixed IP)
  app = await buildTestApp({ logger: logs.logger });
});

afterAll(async () => {
  await prisma.report.deleteMany({ where: { reporterId: { in: visitorIds } } });
  await prisma.visitor.deleteMany({ where: { id: { in: visitorIds } } });
  if (adminId !== '') {
    await prisma.auditLog.deleteMany({ where: { adminId } });
    await prisma.adminUser.delete({ where: { id: adminId } });
  }
  await app.close();
  await prisma.$disconnect();
  await redis.quit();
});

describe('API logs', () => {
  it('contain ids only — no secrets, raw IPs, device ids or user text', async () => {
    const reporter = await newSession(DEVICE_ID);
    const reported = await newSession(randomUUID());

    const turn = await app.inject({
      method: 'GET',
      url: '/v1/turn-credentials',
      remoteAddress: RAW_IP,
      headers: { authorization: `Bearer ${reporter.token}` },
    });
    expect(turn.statusCode).toBe(200);
    const turnCredential = turn
      .json<{ iceServers: { credential?: string }[] }>()
      .iceServers.find((server) => server.credential !== undefined)?.credential;

    const tampered = `${reporter.token.slice(0, -4)}AAAA`;
    const rejected = await app.inject({
      method: 'GET',
      url: '/v1/turn-credentials',
      remoteAddress: RAW_IP,
      headers: { authorization: `Bearer ${tampered}` },
    });
    expect(rejected.statusCode).toBe(401);

    // A report with free text and a transcript (session as the gateway writes it).
    const sessionId = randomUUID();
    const keys = sessionKeys(sessionId);
    await redis.hset(keys.meta, { mode: 'text', state: 'active', startedAt: String(Date.now()) });
    const record = (visitorId: string) =>
      JSON.stringify({
        visitorId,
        status: 'active',
        joinedAt: 0,
        pool: 'normal',
        interests: [],
        autoRequeue: false,
      });
    await redis.hset(keys.participants, 'pLogReporter1', record(reporter.visitorId));
    await redis.hset(keys.participants, 'pLogReported1', record(reported.visitorId));
    await redis.set(
      visitorSessionKey(reporter.visitorId),
      JSON.stringify({ sessionId, participantId: 'pLogReporter1' }),
    );
    await redis.rpush(
      keys.log,
      JSON.stringify({
        sessionId,
        from: 'pLogReported1',
        id: randomUUID(),
        text: CHAT_TEXT,
        at: new Date().toISOString(),
      }),
    );
    const form = new FormData();
    form.append('sessionId', sessionId);
    form.append('reportedParticipantId', 'pLogReported1');
    form.append('reason', 'HARASSMENT');
    form.append('details', REPORT_TEXT);
    const multipart = new Response(form);
    const filed = await app.inject({
      method: 'POST',
      url: '/v1/reports',
      remoteAddress: RAW_IP,
      headers: {
        authorization: `Bearer ${reporter.token}`,
        'content-type': multipart.headers.get('content-type') ?? '',
      },
      payload: Buffer.from(await multipart.arrayBuffer()),
    });
    expect(filed.statusCode).toBe(201);

    // Admin: a failed and a successful login, then an authenticated call with the CSRF header.
    const email = `log-privacy-${randomUUID().slice(0, 8)}@example.test`;
    adminId = (
      await prisma.adminUser.create({
        data: { email, passwordHash: await hash(PASSWORD), role: 'ADMIN' },
      })
    ).id;
    const login = (password: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/admin/auth/login',
        remoteAddress: RAW_IP,
        payload: { email, password },
      });
    expect((await login(WRONG_PASSWORD)).statusCode).toBe(401);
    const signedIn = await login(PASSWORD);
    expect(signedIn.statusCode).toBe(200);
    const cookie = signedIn.cookies.find((c) => c.name === 'rc_admin')?.value ?? '';
    const csrf = signedIn.json<{ csrfToken: string }>().csrfToken;
    const logout = await app.inject({
      method: 'POST',
      url: '/v1/admin/auth/logout',
      remoteAddress: RAW_IP,
      headers: { cookie: `rc_admin=${cookie}`, 'x-admin-csrf': csrf },
    });
    expect(logout.statusCode).toBeLessThan(300);

    const text = logs.text();
    expect(logs.lines.length).toBeGreaterThan(10);
    expect(text).toContain('"requestId"'); // correlation field on request logs
    expect(
      findSecrets(text, {
        'visitor token': reporter.token,
        'tampered token': tampered,
        'raw IP': RAW_IP,
        'device id': DEVICE_ID,
        'TURN credential': turnCredential ?? '',
        password: PASSWORD,
        'wrong password': WRONG_PASSWORD,
        'admin session cookie': cookie,
        'CSRF token': csrf,
        'report details': REPORT_TEXT,
        'chat transcript': CHAT_TEXT,
        email,
      }),
    ).toEqual([]);
  });
});
