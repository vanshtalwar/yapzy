import { type PrismaClient } from '@app/db';
import { type ApiEnv } from '@app/env';
import { type Redis, statsMatchesKey } from '@app/redis';
import {
  adminStatsSchema,
  adminUserListSchema,
  auditPageSchema,
  auditQuerySchema,
  createAdminSchema,
  ErrorCode,
  okSchema,
} from '@app/shared';
import { hash } from '@node-rs/argon2';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { type Clock } from '../../deps.ts';
import { AppError } from '../../errors.ts';
import { type OnlineCounter } from '../../services/online.ts';
import { audit } from '../audit.ts';
import { type AdminGuard, adminOf } from '../guard.ts';
import { pageOf } from '../views.ts';

const params = z.object({ id: z.uuid() });
const ticketRefSchema = z.looseObject({ pool: z.string(), mode: z.string(), lang: z.string() });

/** SCAN helper for the dashboard (admin traffic only, never on the chat hot path). */
async function scanKeys(redis: Redis, pattern: string, max = 20_000): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 1_000);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0' && keys.length < max);
  return keys;
}

/** Live stats, the audit log and admin accounts. */
export const adminSystemRoutes: FastifyPluginAsyncZod<{
  config: ApiEnv;
  prisma: PrismaClient;
  redis: Redis;
  online: OnlineCounter;
  guard: AdminGuard;
  clock: Clock;
}> = (app, { config, prisma, redis, online, guard, clock }) => {
  app.get(
    '/stats',
    { preHandler: guard('stats.read'), schema: { response: { 200: adminStatsSchema } } },
    async () => {
      const now = clock.now();
      // Waiting visitors from their ticket refs; active sessions from session refs (2 per chat).
      const ticketKeys = await scanKeys(redis, 'visitor:*:ticket');
      const waiting: Record<string, number> = {};
      if (ticketKeys.length > 0) {
        for (const raw of await redis.mget(...ticketKeys)) {
          const ref = ticketRefSchema.safeParse(raw === null ? null : JSON.parse(raw));
          if (!ref.success) continue;
          const family = `${ref.data.pool}:${ref.data.mode}:${ref.data.lang}`;
          waiting[family] = (waiting[family] ?? 0) + 1;
        }
      }
      const sessionRefs = (await scanKeys(redis, 'visitor:*:session')).length;

      const minuteMs = 60_000;
      const start = Math.floor(now.getTime() / minuteMs) * minuteMs - 59 * minuteMs;
      const minutes = Array.from({ length: 60 }, (_, index) => new Date(start + index * minuteMs));
      const pipeline = redis.pipeline();
      for (const minute of minutes) {
        pipeline.mget(
          ...Array.from({ length: config.STATS_COUNTER_SHARDS }, (_, shard) =>
            statsMatchesKey(minute, shard),
          ),
        );
      }
      const counts = ((await pipeline.exec()) ?? []).map(([, values]) =>
        (values as (string | null)[]).reduce((sum, value) => sum + Number(value ?? '0'), 0),
      );

      const open = await prisma.report.findMany({
        where: { status: { in: ['OPEN', 'IN_REVIEW'] } },
        select: { priority: true },
      });
      return {
        online: await online.count(),
        activeSessions: Math.ceil(sessionRefs / 2),
        waiting,
        matchesPerMinute: minutes.map((minute, index) => ({
          minute: minute.toISOString(),
          count: counts[index] ?? 0,
        })),
        openReports: {
          total: open.length,
          high: open.filter((r) => r.priority >= 80).length,
          medium: open.filter((r) => r.priority >= 50 && r.priority < 80).length,
          low: open.filter((r) => r.priority < 50).length,
        },
      };
    },
  );

  app.get(
    '/audit',
    {
      preHandler: guard('audit.read'),
      schema: { querystring: auditQuerySchema, response: { 200: auditPageSchema } },
    },
    async (request) => {
      const { action, cursor, limit } = request.query;
      const rows = await prisma.auditLog.findMany({
        where: action === undefined ? {} : { action },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
        include: { admin: { select: { email: true } } },
      });
      const { items, nextCursor } = pageOf(rows, limit);
      return {
        nextCursor,
        items: items.map((entry) => ({
          id: entry.id,
          adminEmail: entry.admin.email,
          action: entry.action,
          targetType: entry.targetType,
          targetId: entry.targetId,
          metadata: entry.metadata,
          createdAt: entry.createdAt.toISOString(),
        })),
      };
    },
  );

  const adminView = (admin: {
    id: string;
    email: string;
    role: 'ADMIN' | 'MODERATOR';
    totpEnabled: boolean;
    lastLoginAt: Date | null;
    disabledAt: Date | null;
    createdAt: Date;
  }) => ({
    id: admin.id,
    email: admin.email,
    role: admin.role,
    totpEnabled: admin.totpEnabled,
    lastLoginAt: admin.lastLoginAt?.toISOString() ?? null,
    disabledAt: admin.disabledAt?.toISOString() ?? null,
    createdAt: admin.createdAt.toISOString(),
  });

  app.get(
    '/admins',
    { preHandler: guard('admins.manage'), schema: { response: { 200: adminUserListSchema } } },
    async () => ({
      items: (await prisma.adminUser.findMany({ orderBy: { createdAt: 'asc' } })).map(adminView),
    }),
  );

  app.post(
    '/admins',
    {
      preHandler: guard('admins.manage'),
      schema: { body: createAdminSchema, response: { 200: okSchema } },
    },
    async (request) => {
      const admin = adminOf(request);
      const email = request.body.email.trim().toLowerCase();
      if ((await prisma.adminUser.count({ where: { email } })) > 0) {
        throw new AppError(409, ErrorCode.CONFLICT, 'An admin with this email exists');
      }
      const passwordHash = await hash(request.body.password);
      await prisma.$transaction(async (tx) => {
        const created = await tx.adminUser.create({
          data: { email, passwordHash, role: request.body.role },
        });
        await audit(tx, {
          adminId: admin.id,
          action: 'admin.create',
          targetType: 'admin',
          targetId: created.id,
          metadata: { role: request.body.role },
        });
      });
      return { ok: true as const };
    },
  );

  app.post(
    '/admins/:id/disable',
    { preHandler: guard('admins.manage'), schema: { params, response: { 200: okSchema } } },
    async (request) => {
      const admin = adminOf(request);
      if (request.params.id === admin.id) {
        throw new AppError(400, ErrorCode.VALIDATION_FAILED, 'You cannot disable yourself');
      }
      await prisma.$transaction(async (tx) => {
        const target = await tx.adminUser.findUnique({ where: { id: request.params.id } });
        if (target === null) throw new AppError(404, ErrorCode.NOT_FOUND, 'Admin not found');
        await tx.adminUser.update({ where: { id: target.id }, data: { disabledAt: clock.now() } });
        await audit(tx, {
          adminId: admin.id,
          action: 'admin.disable',
          targetType: 'admin',
          targetId: target.id,
        });
      });
      return { ok: true as const };
    },
  );

  app.post(
    '/admins/:id/reset-totp',
    { preHandler: guard('admins.manage'), schema: { params, response: { 200: okSchema } } },
    async (request) => {
      const admin = adminOf(request);
      await prisma.$transaction(async (tx) => {
        const target = await tx.adminUser.findUnique({ where: { id: request.params.id } });
        if (target === null) throw new AppError(404, ErrorCode.NOT_FOUND, 'Admin not found');
        await tx.adminUser.update({
          where: { id: target.id },
          data: { totpSecret: null, totpEnabled: false },
        });
        await audit(tx, {
          adminId: admin.id,
          action: 'admin.reset_totp',
          targetType: 'admin',
          targetId: target.id,
        });
      });
      return { ok: true as const };
    },
  );

  return Promise.resolve();
};
