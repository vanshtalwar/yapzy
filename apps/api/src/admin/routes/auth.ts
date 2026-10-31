import { randomBytes } from 'node:crypto';

import { type PrismaClient } from '@app/db';
import { type ApiEnv } from '@app/env';
import { rateLimitKey, type Redis } from '@app/redis';
import {
  adminLoginSchema,
  adminMeSchema,
  ErrorCode,
  okSchema,
  totpSetupResponseSchema,
  totpVerifySchema,
} from '@app/shared';
import { hmacHash } from '@app/shared/crypto';
import { hash, verify } from '@node-rs/argon2';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { generate, generateSecret, generateURI, verify as verifyTotp } from 'otplib';
import QRCode from 'qrcode';

import { type Clock } from '../../deps.ts';
import { AppError } from '../../errors.ts';
import { audit } from '../audit.ts';
import { decryptSecret, encryptSecret } from '../crypto.ts';
import { type AdminGuard, adminOf } from '../guard.ts';
import { createLoginGuard } from '../login-guard.ts';
import { ADMIN_COOKIE, type AdminSessions } from '../sessions.ts';

export const ADMIN_LOGIN_RATE_LIMIT = { max: 5, timeWindow: '1 minute' } as const;
const TOTP_ISSUER = 'RandomChat Admin';

/** Hash of a random password, verified when the email is unknown: same cost either way. */
let dummyHash: Promise<string> | null = null;
const dummy = () => (dummyHash ??= hash(randomBytes(16).toString('hex')));

export interface AuthRouteDeps {
  config: ApiEnv;
  prisma: PrismaClient;
  redis: Redis;
  sessions: AdminSessions;
  guard: AdminGuard;
  clock: Clock;
}

export const adminAuthRoutes: FastifyPluginAsyncZod<AuthRouteDeps> = (app, deps) => {
  const { config, prisma, redis, sessions, guard, clock } = deps;
  const loginGuard = createLoginGuard(redis);
  const secure = config.NODE_ENV === 'production';
  const cookieOptions = {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure,
    path: '/v1/admin',
  };
  const lastStepKey = (adminId: string) => rateLimitKey('admin-totp-step', adminId);

  /** Valid 6-digit code for the stored secret; each time step can be used only once. */
  async function checkTotp(adminId: string, sealed: string | null, code: string) {
    if (sealed === null) return false;
    const secret = decryptSecret(sealed, config.ADMIN_TOTP_ENC_KEY);
    const lastStep = await redis.get(lastStepKey(adminId));
    const epoch = Math.floor(clock.now().getTime() / 1000);
    const result = await verifyTotp({
      secret,
      token: code,
      epochTolerance: 30,
      epoch,
      ...(lastStep === null ? {} : { afterTimeStep: Number(lastStep) }),
    });
    if (!result.valid) return false;
    // Remember the step: the same code can't be replayed (afterTimeStep above).
    const step = 'timeStep' in result ? result.timeStep : Math.floor(epoch / 30);
    await redis.set(lastStepKey(adminId), String(step), 'EX', 300);
    return true;
  }

  const me = (
    admin: { id: string; email: string; role: 'ADMIN' | 'MODERATOR'; totpEnabled: boolean },
    csrf: string,
  ) => ({
    id: admin.id,
    email: admin.email,
    role: admin.role,
    totpEnabled: admin.totpEnabled,
    csrfToken: csrf,
  });

  app.post(
    '/auth/login',
    {
      schema: { body: adminLoginSchema, response: { 200: adminMeSchema } },
      config: {
        rateLimit: {
          ...ADMIN_LOGIN_RATE_LIMIT,
          keyGenerator: (request) => hmacHash(request.ip, config.IP_HASH_PEPPER),
        },
      },
    },
    async (request, reply) => {
      const email = request.body.email.trim().toLowerCase();
      const emailHash = hmacHash(email, config.IP_HASH_PEPPER);
      if (await loginGuard.locked(emailHash)) {
        throw new AppError(
          423,
          ErrorCode.ACCOUNT_LOCKED,
          'Too many failed attempts; try again later',
        );
      }
      if (!(await loginGuard.attempt(emailHash))) {
        throw new AppError(429, ErrorCode.RATE_LIMITED, 'Too many attempts; wait a minute');
      }

      const admin = await prisma.adminUser.findUnique({ where: { email } });
      // Always run argon2 so unknown emails take as long as wrong passwords.
      const passwordOk = await verify(
        admin?.passwordHash ?? (await dummy()),
        request.body.password,
      );
      if (admin === null || !passwordOk || admin.disabledAt !== null) {
        await loginGuard.failure(emailHash);
        throw new AppError(401, ErrorCode.INVALID_CREDENTIALS, 'Invalid email or password');
      }
      if (admin.totpEnabled) {
        if (request.body.totp === undefined) {
          throw new AppError(
            401,
            ErrorCode.TOTP_REQUIRED,
            'Enter the code from your authenticator',
          );
        }
        if (!(await checkTotp(admin.id, admin.totpSecret, request.body.totp))) {
          await loginGuard.failure(emailHash);
          throw new AppError(401, ErrorCode.TOTP_INVALID, 'Invalid authentication code');
        }
      }
      await loginGuard.success(emailHash);

      const now = clock.now();
      const session = await sessions.create(admin.id, now.getTime());
      await prisma.$transaction(async (tx) => {
        await tx.adminUser.update({ where: { id: admin.id }, data: { lastLoginAt: now } });
        await audit(tx, {
          adminId: admin.id,
          action: 'auth.login',
          targetType: 'admin',
          targetId: admin.id,
        });
      });
      void reply.setCookie(ADMIN_COOKIE, session.id, {
        ...cookieOptions,
        maxAge: sessions.ttlSeconds,
      });
      request.log.info({ adminId: admin.id }, 'admin signed in');
      return me(admin, session.csrf);
    },
  );

  app.post(
    '/auth/logout',
    { preHandler: guard(), schema: { response: { 200: okSchema } } },
    async (request, reply) => {
      const admin = adminOf(request);
      await sessions.destroy(admin.sessionId);
      await prisma.$transaction((tx) =>
        audit(tx, {
          adminId: admin.id,
          action: 'auth.logout',
          targetType: 'admin',
          targetId: admin.id,
        }),
      );
      void reply.clearCookie(ADMIN_COOKIE, cookieOptions);
      return { ok: true as const };
    },
  );

  app.get(
    '/auth/me',
    { preHandler: guard(), schema: { response: { 200: adminMeSchema } } },
    (request) => {
      const admin = adminOf(request);
      return me(admin, admin.csrf);
    },
  );

  // TOTP enrolment: a new secret is stored encrypted but only enforced once verified.
  app.post(
    '/auth/totp/setup',
    { preHandler: guard(), schema: { response: { 200: totpSetupResponseSchema } } },
    async (request) => {
      const admin = adminOf(request);
      if (admin.totpEnabled) {
        throw new AppError(409, ErrorCode.CONFLICT, 'Two-factor authentication is already on');
      }
      const secret = generateSecret();
      await prisma.$transaction(async (tx) => {
        await tx.adminUser.update({
          where: { id: admin.id },
          data: {
            totpSecret: encryptSecret(secret, config.ADMIN_TOTP_ENC_KEY),
            totpEnabled: false,
          },
        });
        await audit(tx, {
          adminId: admin.id,
          action: 'totp.setup',
          targetType: 'admin',
          targetId: admin.id,
        });
      });
      const otpauthUrl = generateURI({ issuer: TOTP_ISSUER, label: admin.email, secret });
      return {
        otpauthUrl,
        qrDataUrl: await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 240 }),
      };
    },
  );

  app.post(
    '/auth/totp/verify',
    { preHandler: guard(), schema: { body: totpVerifySchema, response: { 200: okSchema } } },
    async (request) => {
      const admin = adminOf(request);
      const row = await prisma.adminUser.findUniqueOrThrow({ where: { id: admin.id } });
      if (row.totpEnabled || !(await checkTotp(admin.id, row.totpSecret, request.body.code))) {
        throw new AppError(400, ErrorCode.TOTP_INVALID, 'Invalid authentication code');
      }
      await prisma.$transaction(async (tx) => {
        await tx.adminUser.update({ where: { id: admin.id }, data: { totpEnabled: true } });
        await audit(tx, {
          adminId: admin.id,
          action: 'totp.enable',
          targetType: 'admin',
          targetId: admin.id,
        });
      });
      return { ok: true as const };
    },
  );

  return Promise.resolve();
};

/** Test helper: the current code for an encrypted secret. */
export async function totpCodeFor(sealed: string, keyHex: string, at: Date): Promise<string> {
  return generate({
    secret: decryptSecret(sealed, keyHex),
    epoch: Math.floor(at.getTime() / 1000),
  });
}
