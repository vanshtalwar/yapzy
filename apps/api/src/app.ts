import { randomUUID } from 'node:crypto';

import { createLogger } from '@app/logger';
import { createBanChecker } from '@app/moderation';
import { API_RATE_LIMIT_PREFIX } from '@app/redis';
import { ErrorCode } from '@app/shared';
import { createVisitorTokenService } from '@app/shared/visitor-token';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import Fastify, { type FastifyBaseLogger, LogController } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

import { type AppDeps, systemClock } from './deps.ts';
import { AppError } from './errors.ts';
import { authPlugin } from './plugins/auth.ts';
import { registerErrorHandling } from './plugins/error-handler.ts';
import { configRoutes } from './routes/config.ts';
import { healthRoutes } from './routes/health.ts';
import { sessionRoutes } from './routes/session.ts';
import { statsRoutes } from './routes/stats.ts';
import { turnRoutes } from './routes/turn.ts';
import { createOnlineCounter } from './services/online.ts';

export const BODY_LIMIT_BYTES = 64 * 1024;

export async function buildApp(deps: AppDeps) {
  const { config, prisma, redis, turnstile } = deps;
  const clock = deps.clock ?? systemClock;
  // Typed as Fastify's base logger so the instance stays compatible with plugin typings.
  const logger: FastifyBaseLogger =
    deps.logger ??
    createLogger({ service: 'api', level: config.LOG_LEVEL, nodeEnv: config.NODE_ENV });

  const trustProxy = config.TRUST_PROXY;
  const app = Fastify({
    loggerInstance: logger,
    bodyLimit: BODY_LIMIT_BYTES,
    // A hop count trusts the N closest proxies, like proxy-addr's numeric option.
    trustProxy:
      typeof trustProxy === 'number'
        ? (_address: string, hop: number) => hop < trustProxy
        : trustProxy,
    // Request ids are generated server-side only; a client-chosen id could be used to forge
    // or collide log correlation.
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    logController: new LogController({ requestIdLogLabel: 'requestId' }),
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandling(app);

  app.addHook('onSend', async (request, reply) => {
    void reply.header('x-request-id', request.id);
  });

  await app.register(helmet);
  const allowedOrigins = new Set(config.CORS_ORIGINS);
  await app.register(cors, {
    // Requests without Origin (curl, server-to-server) are not CORS requests at all.
    origin: (origin, callback) => {
      callback(null, origin === undefined || allowedOrigins.has(origin));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type'],
    exposedHeaders: ['x-request-id', 'retry-after'],
    maxAge: 600,
  });
  await app.register(sensible);

  const rateLimitDisabled = config.RATE_LIMIT_DISABLED && config.NODE_ENV === 'development';
  if (rateLimitDisabled) {
    app.log.warn('rate limiting DISABLED (RATE_LIMIT_DISABLED=true in development)');
  } else {
    if (config.RATE_LIMIT_DISABLED) {
      app.log.warn('RATE_LIMIT_DISABLED ignored outside NODE_ENV=development');
    }
    await app.register(rateLimit, {
      global: false,
      redis,
      nameSpace: API_RATE_LIMIT_PREFIX,
      // Fail open if Redis is down: Turnstile still gates sessions, and refusing everyone
      // would be worse than briefly unlimited requests.
      skipOnError: true,
      errorResponseBuilder: (_request, context) =>
        new AppError(429, ErrorCode.RATE_LIMITED, `Too many requests; retry in ${context.after}`),
    });
  }

  const tokens = createVisitorTokenService({
    secret: config.JWT_SECRET,
    ttlSeconds: config.JWT_TTL_SECONDS,
    now: () => clock.now(),
  });
  await app.register(authPlugin, { tokens });

  const bans = createBanChecker({ prisma, redis, logger: app.log, now: () => clock.now() });
  const online = createOnlineCounter({ redis, clock });

  await app.register(healthRoutes, { prisma, redis });
  await app.register(configRoutes, { tosVersion: config.TOS_VERSION });
  await app.register(sessionRoutes, { config, prisma, turnstile, bans, tokens, clock });
  await app.register(turnRoutes, { config, clock });
  await app.register(statsRoutes, { online });

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
