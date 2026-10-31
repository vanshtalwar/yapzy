import { randomBytes, randomUUID } from 'node:crypto';

import { type GwControlMessage, rateLimitKey, subscribeControl } from '@app/redis';
import { createTestRedis } from '@app/redis/testing';
import { hmacHash } from '@app/shared/crypto';
import { createMemoryObjectStore } from '@app/storage';
import { hash } from '@node-rs/argon2';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { encryptSecret } from './admin/crypto.ts';
import { totpCodeFor } from './admin/routes/auth.ts';
import { type App } from './app.ts';
import { createRecordingJobs } from './services/jobs.ts';
import {
  buildTestApp,
  createFakeClock,
  prisma,
  randomTestIp,
  redis,
  testConfig,
} from './test/helpers.ts';

const clock = createFakeClock();
const objects = createMemoryObjectStore();
const controlChannel = `test:gw:control:${randomUUID()}`;
const subscriber = createTestRedis('api-admin-sub', { dbIndex: 14 });
let app: App;

const PASSWORD = 'correct horse battery staple';
const adminIds: string[] = [];
const visitorIds: string[] = [];

interface AdminSession {
  cookie: string;
  csrf: string;
}

async function createAdmin(role: 'ADMIN' | 'MODERATOR', extra: { totpSecret?: string } = {}) {
  const email = `${role.toLowerCase()}-${randomUUID().slice(0, 8)}@example.test`;
  const admin = await prisma.adminUser.create({
    data: {
      email,
      passwordHash: await hash(PASSWORD),
      role,
      ...(extra.totpSecret === undefined
        ? {}
        : {
            totpSecret: encryptSecret(extra.totpSecret, testConfig.ADMIN_TOTP_ENC_KEY),
            totpEnabled: true,
          }),
    },
  });
  adminIds.push(admin.id);
  return admin;
}

function login(email: string, password = PASSWORD, totp?: string) {
  return app.inject({
    method: 'POST',
    url: '/v1/admin/auth/login',
    remoteAddress: randomTestIp(),
    payload: { email, password, ...(totp === undefined ? {} : { totp }) },
  });
}

async function signIn(email: string): Promise<AdminSession> {
  const response = await login(email);
  expect(response.statusCode).toBe(200);
  const cookie = response.cookies.find((c) => c.name === 'rc_admin');
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/v1/admin' });
  return {
    cookie: `rc_admin=${cookie?.value ?? ''}`,
    csrf: response.json<{ csrfToken: string }>().csrfToken,
  };
}

function call(
  session: AdminSession | null,
  method: 'GET' | 'POST',
  url: string,
  payload?: Record<string, unknown>,
  csrf: string | null = session?.csrf ?? null,
) {
  return app.inject({
    method,
    url: `/v1/admin${url}`,
    headers: {
      ...(session === null ? {} : { cookie: session.cookie }),
      ...(csrf === null ? {} : { 'x-admin-csrf': csrf }),
    },
    ...(payload === undefined ? {} : { payload }),
  });
}

async function visitor(): Promise<string> {
  const row = await prisma.visitor.create({
    data: { deviceIdHash: randomBytes(32).toString('hex') },
  });
  visitorIds.push(row.id);
  return row.id;
}

async function report(reportedId: string, evidenceKeys: string[] = []) {
  const reporterId = await visitor();
  const row = await prisma.report.create({
    data: {
      sessionId: randomUUID(),
      reporterId,
      reportedId,
      reportedParticipantId: 'pReported001',
      reason: 'HARASSMENT',
      priority: 50,
      transcript: [{ from: 'reported', text: 'rude words', at: clock.now().toISOString() }],
    },
  });
  for (const key of evidenceKeys) {
    await prisma.evidence.create({
      data: { reportId: row.id, type: 'FRAME', storageKey: key, sha256: 'a'.repeat(64) },
    });
  }
  return row.id;
}

const auditActions = async (adminId: string) =>
  (await prisma.auditLog.findMany({ where: { adminId }, orderBy: { createdAt: 'asc' } })).map(
    (entry) => entry.action,
  );

beforeAll(async () => {
  app = await buildTestApp({ clock, objects, jobs: createRecordingJobs(), controlChannel });
});

beforeEach(async () => {
  await redis.flushdb();
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { adminId: { in: adminIds } } });
  await prisma.ban.deleteMany({ where: { visitorId: { in: visitorIds } } });
  await prisma.report.deleteMany({ where: { reportedId: { in: visitorIds } } });
  await prisma.visitor.deleteMany({ where: { id: { in: visitorIds } } });
  await prisma.adminUser.deleteMany({ where: { id: { in: adminIds } } });
  await app.close();
  await prisma.$disconnect();
  await Promise.all([redis.quit(), subscriber.quit()]);
});

describe('admin auth', () => {
  it('rejects wrong passwords and unknown emails the same way, and disabled admins', async () => {
    const admin = await createAdmin('MODERATOR');
    const wrong = await login(admin.email, 'nope');
    expect(wrong.statusCode).toBe(401);
    const unknown = await login('ghost@example.test', PASSWORD);
    expect(unknown.json()).toMatchObject({
      error: {
        code: 'INVALID_CREDENTIALS',
        message: wrong.json<{ error: { message: string } }>().error.message,
      },
    });
    expect((await call(null, 'GET', '/auth/me')).statusCode).toBe(401);

    await prisma.adminUser.update({ where: { id: admin.id }, data: { disabledAt: new Date() } });
    expect((await login(admin.email)).statusCode).toBe(401);
  });

  it('rate-limits per email and locks the account after repeated failures', async () => {
    const admin = await createAdmin('MODERATOR');
    const emailHash = hmacHash(admin.email, testConfig.IP_HASH_PEPPER);
    for (let i = 0; i < 5; i += 1) expect((await login(admin.email, 'wrong')).statusCode).toBe(401);
    expect((await login(admin.email, 'wrong')).json()).toMatchObject({
      error: { code: 'RATE_LIMITED' },
    });
    await redis.del(rateLimitKey('admin-login', emailHash)); // a minute later
    for (let i = 0; i < 5; i += 1) await login(admin.email, 'wrong');
    await redis.del(rateLimitKey('admin-login', emailHash));
    const locked = await login(admin.email); // right password, still locked
    expect(locked.statusCode).toBe(423);
    expect(locked.json()).toMatchObject({ error: { code: 'ACCOUNT_LOCKED' } });
  });

  it('requires a valid, unused TOTP code when two-factor is on', async () => {
    const secret = 'JBSWY3DPEHPK3PXP'.repeat(2);
    const admin = await createAdmin('ADMIN', { totpSecret: secret });
    const sealed =
      (await prisma.adminUser.findUniqueOrThrow({ where: { id: admin.id } })).totpSecret ?? '';
    expect(sealed).not.toContain(secret); // encrypted at rest
    expect((await login(admin.email)).json()).toMatchObject({ error: { code: 'TOTP_REQUIRED' } });
    expect((await login(admin.email, PASSWORD, '000000')).json()).toMatchObject({
      error: { code: 'TOTP_INVALID' },
    });
    const code = await totpCodeFor(sealed, testConfig.ADMIN_TOTP_ENC_KEY, clock.now());
    expect((await login(admin.email, PASSWORD, code)).statusCode).toBe(200);
    expect((await login(admin.email, PASSWORD, code)).json()).toMatchObject({
      error: { code: 'TOTP_INVALID' },
    }); // replay
  });

  it('enrols TOTP: setup returns a QR code, verify turns it on', async () => {
    const admin = await createAdmin('MODERATOR');
    const session = await signIn(admin.email);
    const setup = await call(session, 'POST', '/auth/totp/setup');
    expect(setup.statusCode).toBe(200);
    expect(setup.json()).toMatchObject({
      otpauthUrl: expect.stringMatching(/^otpauth:\/\/totp\//) as unknown,
      qrDataUrl: expect.stringMatching(/^data:image\/png;base64,/) as unknown,
    });
    const sealed =
      (await prisma.adminUser.findUniqueOrThrow({ where: { id: admin.id } })).totpSecret ?? '';
    const code = await totpCodeFor(sealed, testConfig.ADMIN_TOTP_ENC_KEY, clock.now());
    expect((await call(session, 'POST', '/auth/totp/verify', { code })).statusCode).toBe(200);
    expect(await prisma.adminUser.findUniqueOrThrow({ where: { id: admin.id } })).toMatchObject({
      totpEnabled: true,
    });
    expect(await auditActions(admin.id)).toEqual(['auth.login', 'totp.setup', 'totp.enable']);
  });

  it('requires TOTP enrolment before anything else when DEPLOY_ENV=production', async () => {
    const standard = app;
    app = await buildTestApp({
      clock,
      objects,
      jobs: createRecordingJobs(),
      controlChannel,
      config: { ...testConfig, DEPLOY_ENV: 'production' },
    });
    try {
      const admin = await createAdmin('ADMIN');
      const session = await signIn(admin.email);
      expect((await call(session, 'GET', '/auth/me')).json()).toMatchObject({
        totpEnabled: false,
        totpRequired: true,
      });
      expect((await call(session, 'GET', '/reports')).json()).toMatchObject({
        error: { code: 'TOTP_ENROLLMENT_REQUIRED' },
      });
      expect((await call(session, 'POST', '/auth/totp/setup')).statusCode).toBe(200);
      const sealed =
        (await prisma.adminUser.findUniqueOrThrow({ where: { id: admin.id } })).totpSecret ?? '';
      const code = await totpCodeFor(sealed, testConfig.ADMIN_TOTP_ENC_KEY, clock.now());
      expect((await call(session, 'POST', '/auth/totp/verify', { code })).statusCode).toBe(200);
      expect((await call(session, 'GET', '/reports')).statusCode).toBe(200);
    } finally {
      await app.close();
      app = standard;
    }
  });
});

describe('CSRF and RBAC', () => {
  it('requires the session CSRF token on every mutation', async () => {
    const admin = await createAdmin('MODERATOR');
    const session = await signIn(admin.email);
    const id = await report(await visitor());
    expect(
      (await call(session, 'POST', `/reports/${id}/assign`, undefined, null)).json(),
    ).toMatchObject({ error: { code: 'CSRF_FAILED' } });
    expect(
      (await call(session, 'POST', `/reports/${id}/assign`, undefined, 'x'.repeat(43))).statusCode,
    ).toBe(403);
    expect((await call(session, 'GET', `/reports/${id}`, undefined, null)).statusCode).toBe(200);
    expect((await call(session, 'POST', `/reports/${id}/assign`)).statusCode).toBe(200);
  });

  it('applies the role matrix', async () => {
    const moderator = await signIn((await createAdmin('MODERATOR')).email);
    const admin = await signIn((await createAdmin('ADMIN')).email);
    const target = await visitor();
    const ban = (type: 'HARD' | 'SHADOW', durationHours: number | null) => ({
      visitorId: target,
      type,
      durationHours,
      reason: 'rbac test',
    });

    expect((await call(moderator, 'GET', '/stats')).statusCode).toBe(200);
    expect((await call(moderator, 'GET', '/audit')).statusCode).toBe(403);
    expect((await call(moderator, 'GET', '/admins')).statusCode).toBe(403);
    expect(
      (
        await call(moderator, 'POST', '/admins', {
          email: 'x@example.test',
          password: 'p'.repeat(12),
          role: 'ADMIN',
        })
      ).statusCode,
    ).toBe(403);
    expect((await call(moderator, 'POST', '/bans', ban('HARD', null))).statusCode).toBe(403);
    expect((await call(moderator, 'POST', '/bans', ban('HARD', 721))).statusCode).toBe(403);
    expect((await call(moderator, 'POST', '/bans', ban('HARD', 720))).statusCode).toBe(200);
    expect((await call(moderator, 'POST', '/bans', ban('SHADOW', null))).statusCode).toBe(200);
    const banId = (await prisma.ban.findFirstOrThrow({ where: { visitorId: target } })).id;
    expect((await call(moderator, 'POST', `/bans/${banId}/revoke`)).statusCode).toBe(403);

    expect((await call(admin, 'GET', '/audit')).statusCode).toBe(200);
    expect((await call(admin, 'POST', '/bans', ban('HARD', null))).statusCode).toBe(200);
    expect((await call(admin, 'POST', `/bans/${banId}/revoke`)).statusCode).toBe(200);
  });
});

describe('reports & audit', () => {
  it('signs URLs only for the evidence of the requested report', async () => {
    const session = await signIn((await createAdmin('MODERATOR')).email);
    const reported = await visitor();
    const mine = await report(reported, [`reports/r1-${randomUUID()}/1.jpg`]);
    await report(reported, [`reports/r2-${randomUUID()}/1.jpg`]);
    const detail = await call(session, 'GET', `/reports/${mine}`);
    expect(detail.statusCode).toBe(200);
    const body = detail.json<{
      evidence: { url: string }[];
      transcript: unknown[];
      reported: { reportsReceived: number };
    }>();
    expect(body.evidence).toHaveLength(1);
    expect(body.evidence[0]?.url).toMatch(/^memory:\/\/evidence\/reports%2Fr1-.*expires=300$/);
    expect(body.transcript).toEqual([expect.objectContaining({ text: 'rude words' })]);
    expect(body.reported.reportsReceived).toBe(2);
  });

  it('a ban action resolves the report, publishes ban_applied and is audited', async () => {
    const admin = await createAdmin('MODERATOR');
    const session = await signIn(admin.email);
    const reported = await visitor();
    const id = await report(reported);
    const messages: GwControlMessage[] = [];
    const unsubscribe = await subscribeControl(
      subscriber,
      { onMessage: (m) => messages.push(m) },
      controlChannel,
    );

    const response = await call(session, 'POST', `/reports/${id}/action`, {
      ban: { type: 'HARD', durationHours: 24 },
      trustDelta: -15,
      note: 'abusive',
    });
    expect(response.statusCode).toBe(200);
    expect(await prisma.report.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'ACTIONED',
      resolutionNote: 'abusive',
      assignedToId: admin.id,
    });
    const ban = await prisma.ban.findFirstOrThrow({ where: { visitorId: reported } });
    expect(ban).toMatchObject({ type: 'HARD', createdByAdminId: admin.id });
    expect(ban.expiresAt?.getTime()).toBe(clock.now().getTime() + 24 * 3_600_000);
    expect((await prisma.visitor.findUniqueOrThrow({ where: { id: reported } })).trustScore).toBe(
      35,
    );
    await expect.poll(() => messages.length).toBe(1);
    expect(messages[0]).toMatchObject({
      type: 'ban_applied',
      banId: ban.id,
      banType: 'HARD',
      visitorId: reported,
    });
    await unsubscribe();

    // Every mutation is audited.
    const other = await report(reported);
    await call(session, 'POST', `/reports/${other}/assign`);
    await call(session, 'POST', `/reports/${other}/note`, { note: 'looking' });
    await call(session, 'POST', `/reports/${other}/dismiss`, { note: 'not a violation' });
    await call(session, 'POST', '/auth/logout');
    expect(await auditActions(admin.id)).toEqual([
      'auth.login',
      'report.action',
      'report.assign',
      'report.note',
      'report.dismiss',
      'auth.logout',
    ]);
    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { adminId: admin.id, action: 'report.action' },
    });
    expect(entry).toMatchObject({
      targetType: 'report',
      targetId: id,
      metadata: expect.objectContaining({ banId: ban.id }) as unknown,
    });
    expect((await call(session, 'GET', '/auth/me')).statusCode).toBe(401); // logged out
  });

  it('admins manage accounts; stats and lists respond', async () => {
    const root = await createAdmin('ADMIN');
    const session = await signIn(root.email);
    const email = `new-${randomUUID().slice(0, 8)}@example.test`;
    expect(
      (
        await call(session, 'POST', '/admins', {
          email,
          password: 'p'.repeat(12),
          role: 'MODERATOR',
        })
      ).statusCode,
    ).toBe(200);
    const created = await prisma.adminUser.findUniqueOrThrow({ where: { email } });
    adminIds.push(created.id);
    expect((await call(session, 'POST', `/admins/${created.id}/reset-totp`)).statusCode).toBe(200);
    expect((await call(session, 'POST', `/admins/${created.id}/disable`)).statusCode).toBe(200);
    expect((await call(session, 'POST', `/admins/${root.id}/disable`)).statusCode).toBe(400);
    expect((await login(email, 'p'.repeat(12))).statusCode).toBe(401);
    expect(await auditActions(root.id)).toEqual([
      'auth.login',
      'admin.create',
      'admin.reset_totp',
      'admin.disable',
    ]);

    const stats = await call(session, 'GET', '/stats');
    expect(stats.statusCode).toBe(200);
    expect(stats.json()).toMatchObject({
      online: 0,
      activeSessions: 0,
      waiting: {},
      openReports: expect.any(Object) as unknown,
    });
    expect(stats.json<{ matchesPerMinute: unknown[] }>().matchesPerMinute).toHaveLength(60);
    const reports = await call(session, 'GET', '/reports?status=OPEN&limit=2');
    expect(reports.json<{ items: unknown[] }>().items.length).toBeLessThanOrEqual(2);
    expect((await call(session, 'GET', '/moderation-events')).statusCode).toBe(200);
    expect((await call(session, 'GET', `/visitors/${randomUUID()}`)).statusCode).toBe(404);
    expect(stats.headers['x-robots-tag']).toBe('noindex, nofollow');
  });
});
