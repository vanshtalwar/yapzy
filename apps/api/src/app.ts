import { randomUUID } from 'node:crypto';

import { createLogger } from '@app/logger';
import { metricsAccess } from '@app/metrics';
import {
  createBanChecker,
  createBanService,
  createRiskProfiles,
  createTrustStore,
} from '@app/moderation';
import { API_RATE_LIMIT_PREFIX } from '@app/redis';
import { ADMIN_CSRF_HEADER, ErrorCode } from '@app/shared';
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

import { adminRoutes } from './admin/index.ts';
import { type AppDeps, systemClock } from './deps.ts';
import { AppError } from './errors.ts';
import { createDefaultApiMetrics } from './metrics.ts';
import { authPlugin } from './plugins/auth.ts';
import { registerErrorHandling } from './plugins/error-handler.ts';
import { configRoutes } from './routes/config.ts';
import { frameRoutes } from './routes/frames.ts';
import { healthRoutes } from './routes/health.ts';
import { reportRoutes } from './routes/reports.ts';
import { sessionRoutes } from './routes/session.ts';
import { statsRoutes } from './routes/stats.ts';
import { turnRoutes } from './routes/turn.ts';
import { createOnlineCounter } from './services/online.ts';
import { createSessionState } from './services/session-state.ts';

export const BODY_LIMIT_BYTES = 64 * 1024;

export async function buildApp(deps: AppDeps) {
  const { config, prisma, redis, turnstile, objects, jobs } = deps;
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

  const metrics = deps.metrics ?? createDefaultApiMetrics(config.NODE_ENV !== 'test');
  app.addHook('onResponse', async (request, reply) => {
    // The route pattern (not the raw URL) keeps label cardinality bounded.
    const route = request.routeOptions.url ?? 'unmatched';
    const status = String(reply.statusCode);
    metrics.httpDuration.observe(
      { method: request.method, route, status },
      reply.elapsedTime / 1_000,
    );
    if (reply.statusCode === 429) metrics.rateLimitHits.inc({ route });
  });
  const metricsAccessOptions = {
    token: config.METRICS_TOKEN,
    requireToken: config.DEPLOY_ENV === 'production',
  };
  if (metricsAccessOptions.requireToken && config.METRICS_TOKEN === undefined) {
    app.log.warn('METRICS_TOKEN not set: /metrics is disabled (DEPLOY_ENV=production)');
  }
  app.get('/metrics', async (request, reply) => {
    const access = metricsAccess(request.headers.authorization, metricsAccessOptions);
    if (access === 'disabled') throw new AppError(404, ErrorCode.NOT_FOUND, 'Not found');
    if (access === 'unauthorized') {
      throw new AppError(401, ErrorCode.UNAUTHORIZED, 'Metrics token required');
    }
    return reply
      .header('content-type', metrics.registry.contentType)
      .header('cache-control', 'no-store')
      .send(await metrics.registry.metrics());
  });

  await app.register(helmet);
  const publicOrigins = new Set(config.CORS_ORIGINS);
  const adminOrigins = new Set(config.ADMIN_ORIGINS);
  await app.register(cors, {
    // Two policies: visitors use a Bearer header (no credentials, no admin header); only the
    // admin origins may send the session cookie and CSRF header to /v1/admin/*. A script on
    // the public site (XSS, compromised dependency) therefore can't act as a moderator who
    // happens to visit it.
    delegator: (request, callback) => {
      const admin = request.url === '/v1/admin' || request.url.startsWith('/v1/admin/');
      const origin = request.headers.origin;
      // Requests without Origin (curl, server-to-server) are not CORS requests at all.
      const allowed = origin === undefined || (admin ? adminOrigins : publicOrigins).has(origin);
      callback(null, {
        origin: allowed,
        methods: ['GET', 'POST', 'OPTIONS'],
        allowedHeaders: admin
          ? ['content-type', ADMIN_CSRF_HEADER]
          : ['authorization', 'content-type'],
        credentials: admin,
        exposedHeaders: ['x-request-id', 'retry-after'],
        maxAge: 600,
      });
    },
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
  const trust = createTrustStore({ prisma, redis });
  const risk = createRiskProfiles({ redis });
  await app.register(sessionRoutes, {
    config,
    prisma,
    turnstile,
    bans,
    trust,
    risk,
    tokens,
    clock,
  });
  await app.register(turnRoutes, { config, clock, bans });
  await app.register(statsRoutes, { online });
  const sessions = createSessionState(redis);
  await app.register(reportRoutes, {
    config,
    prisma,
    objects,
    jobs,
    sessions,
    clock,
    metrics,
    bans,
  });
  await app.register(frameRoutes, { config, redis, objects, jobs, sessions, clock });

  const banService = createBanService({
    prisma,
    redis,
    logger: app.log,
    originNodeId: 'api',
    ...(deps.controlChannel === undefined ? {} : { controlChannel: deps.controlChannel }),
  });
  await app.register(adminRoutes, {
    prefix: '/v1/admin',
    config,
    prisma,
    redis,
    objects,
    bans: banService,
    trust,
    online,
    clock,
    chatSessions: sessions,
    recordAction: (action) => {
      metrics.moderationActions.inc({ source: 'admin', action });
    },
  });

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
