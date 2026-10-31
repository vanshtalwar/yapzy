import { onlineStatsSchema } from '@app/shared';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

import { type OnlineCounter } from '../services/online.ts';

export const statsRoutes: FastifyPluginAsyncZod<{ online: OnlineCounter }> = (app, { online }) => {
  app.get(
    '/v1/stats/online',
    { schema: { response: { 200: onlineStatsSchema } } },
    async (_request, reply) => {
      void reply.header('cache-control', 'public, max-age=2');
      return { online: await online.count() };
    },
  );
  return Promise.resolve();
};
