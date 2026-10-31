import { type PrismaClient } from '@app/db';
import { type ApiEnv } from '@app/env';
import { type BanService, type TrustStore } from '@app/moderation';
import { type Redis } from '@app/redis';
import { type ObjectStore } from '@app/storage';
import cookie from '@fastify/cookie';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

import { type Clock } from '../deps.ts';
import { type OnlineCounter } from '../services/online.ts';
import { createAdminGuard } from './guard.ts';
import { adminAuthRoutes } from './routes/auth.ts';
import { adminModerationRoutes } from './routes/moderation.ts';
import { adminReportRoutes } from './routes/reports.ts';
import { adminSystemRoutes } from './routes/system.ts';
import { createAdminSessions } from './sessions.ts';

export interface AdminRouteDeps {
  config: ApiEnv;
  prisma: PrismaClient;
  redis: Redis;
  objects: ObjectStore;
  bans: BanService;
  trust: TrustStore;
  online: OnlineCounter;
  clock: Clock;
}

/**
 * `/v1/admin/*` (Part 9): cookie sessions (separate from visitor JWTs), CSRF header on every
 * mutation, RBAC per route, every change audited in its own transaction.
 */
export const adminRoutes: FastifyPluginAsyncZod<AdminRouteDeps> = async (app, deps) => {
  await app.register(cookie);
  app.decorateRequest('admin', null);
  app.addHook('onSend', async (_request, reply) => {
    void reply.header('x-robots-tag', 'noindex, nofollow');
    void reply.header('cache-control', 'no-store');
  });

  const { config, prisma, redis, objects, bans, trust, online, clock } = deps;
  const sessions = createAdminSessions(redis, config.ADMIN_SESSION_TTL_SECONDS);
  const guard = createAdminGuard({ prisma, sessions });
  // Explicit options: spreading `deps` would pass the `prefix` option on and apply it twice.
  const shared = { config, prisma, redis, objects, bans, trust, online, clock, guard };
  await app.register(adminAuthRoutes, { ...shared, sessions });
  await app.register(adminReportRoutes, shared);
  await app.register(adminModerationRoutes, shared);
  await app.register(adminSystemRoutes, shared);
};
