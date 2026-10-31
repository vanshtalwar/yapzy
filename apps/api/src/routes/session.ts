import { Prisma, type PrismaClient } from '@app/db';
import { type ApiEnv } from '@app/env';
import { type BanChecker } from '@app/moderation';
import { ErrorCode } from '@app/shared';
import { hmacHash } from '@app/shared/crypto';
import { type VisitorTokenService } from '@app/shared/visitor-token';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { type Clock } from '../deps.ts';
import { AppError } from '../errors.ts';
import { TurnstileUnavailableError, type TurnstileVerifier } from '../services/turnstile.ts';

const sessionBody = z.object({
  turnstileToken: z.string().min(1).max(2048),
  ageConfirmed: z.boolean(),
  tosVersion: z.string().min(1).max(32),
  /** Random UUID the browser keeps in localStorage; only its HMAC is stored. */
  deviceId: z.uuid(),
});

const sessionResponse = z.object({
  token: z.string(),
  visitorId: z.uuid(),
  expiresAt: z.iso.datetime(),
});

export interface SessionRouteOptions {
  config: ApiEnv;
  prisma: PrismaClient;
  turnstile: TurnstileVerifier;
  bans: BanChecker;
  tokens: VisitorTokenService;
  clock: Clock;
}

export const SESSION_RATE_LIMIT = { max: 10, timeWindow: '1 minute' } as const;

export const sessionRoutes: FastifyPluginAsyncZod<SessionRouteOptions> = (app, options) => {
  const { config, prisma, turnstile, bans, tokens, clock } = options;
  const ipHashOf = (ip: string) => hmacHash(ip, config.IP_HASH_PEPPER);

  async function upsertVisitor(deviceIdHash: string, ipHash: string, tosVersion: string) {
    const now = clock.now();
    const seen = { lastIpHash: ipHash, lastSeenAt: now, ageConfirmedAt: now, tosVersion };
    const upsert = () =>
      prisma.visitor.upsert({
        where: { deviceIdHash },
        create: { deviceIdHash, firstSeenAt: now, ...seen },
        update: seen,
        select: { id: true },
      });
    try {
      return await upsert();
    } catch (error) {
      // Two concurrent first visits from one device race on the unique index; the retry updates.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return upsert();
      }
      throw error;
    }
  }

  app.post(
    '/v1/session',
    {
      schema: { body: sessionBody, response: { 200: sessionResponse } },
      config: {
        rateLimit: { ...SESSION_RATE_LIMIT, keyGenerator: (request) => ipHashOf(request.ip) },
      },
    },
    async (request) => {
      const body = request.body;

      if (!body.ageConfirmed) {
        throw new AppError(
          400,
          ErrorCode.AGE_NOT_CONFIRMED,
          'You must confirm you are 18 or older',
        );
      }
      if (body.tosVersion !== config.TOS_VERSION) {
        throw new AppError(409, ErrorCode.TOS_OUTDATED, 'The terms of service have changed', {
          tosVersion: config.TOS_VERSION,
        });
      }

      let verdict;
      try {
        verdict = await turnstile.verify(body.turnstileToken);
      } catch (error) {
        if (!(error instanceof TurnstileUnavailableError)) throw error;
        request.log.warn({ err: error }, 'turnstile unavailable');
        throw new AppError(503, ErrorCode.SERVICE_UNAVAILABLE, 'Bot check unavailable; retry soon');
      }
      if (!verdict.success) {
        request.log.info({ errorCodes: verdict.errorCodes }, 'turnstile rejected');
        throw new AppError(403, ErrorCode.TURNSTILE_FAILED, 'Bot check failed; please retry');
      }

      // UUIDs are case-insensitive; normalize so one device always hashes the same.
      const deviceIdHash = hmacHash(body.deviceId.toLowerCase(), config.DEVICE_HASH_PEPPER);
      const ipHash = ipHashOf(request.ip);
      const visitor = await upsertVisitor(deviceIdHash, ipHash, body.tosVersion);

      // SHADOW bans get a normal token on purpose: the gateway routes them to the shadow pool
      // without telling them.
      const ban = await bans.findActiveBan({ visitorId: visitor.id, deviceIdHash, ipHash });
      if (ban?.type === 'HARD') {
        request.log.info({ visitorId: visitor.id, banId: ban.banId }, 'banned visitor refused');
        throw new AppError(403, ErrorCode.BANNED, 'Access denied', { expiresAt: ban.expiresAt });
      }

      const { token, expiresAt } = await tokens.issue(visitor.id);
      request.log.info({ visitorId: visitor.id }, 'visitor session issued');
      return { token, visitorId: visitor.id, expiresAt: expiresAt.toISOString() };
    },
  );
  return Promise.resolve();
};
