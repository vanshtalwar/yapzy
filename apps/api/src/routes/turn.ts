import { type ApiEnv } from '@app/env';
import { ErrorCode, turnCredentialsSchema } from '@app/shared';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

import { type Clock } from '../deps.ts';
import { AppError } from '../errors.ts';
import { createTurnCredentials } from '../services/turn.ts';

export const TURN_RATE_LIMIT = { max: 30, timeWindow: '1 minute' } as const;

export const turnRoutes: FastifyPluginAsyncZod<{ config: ApiEnv; clock: Clock }> = (
  app,
  { config, clock },
) => {
  app.get(
    '/v1/turn-credentials',
    {
      onRequest: [app.authenticate],
      schema: { response: { 200: turnCredentialsSchema } },
      config: {
        // Keyed by visitor, so it must run after authentication (preHandler > onRequest).
        rateLimit: {
          ...TURN_RATE_LIMIT,
          hook: 'preHandler',
          keyGenerator: (request) => request.visitor?.id ?? 'anonymous',
        },
      },
    },
    (request, reply) => {
      const visitor = request.visitor;
      if (visitor === null) throw new AppError(401, ErrorCode.UNAUTHORIZED, 'Missing bearer token');
      void reply.header('cache-control', 'no-store');
      return createTurnCredentials({
        visitorId: visitor.id,
        now: clock.now(),
        secret: config.TURN_SECRET,
        ttlSeconds: config.TURN_CREDENTIAL_TTL_SECONDS,
        host: config.TURN_HOST,
        port: config.TURN_PORT,
        stunUrls: config.STUN_URLS,
      });
    },
  );
  return Promise.resolve();
};
