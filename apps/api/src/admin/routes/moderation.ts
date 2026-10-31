import { type PrismaClient } from '@app/db';
import { type BanService } from '@app/moderation';
import {
  banPageSchema,
  banQuerySchema,
  createBanSchema,
  ErrorCode,
  eventPageSchema,
  eventQuerySchema,
  okSchema,
  visitorProfileSchema,
} from '@app/shared';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { type Clock } from '../../deps.ts';
import { AppError } from '../../errors.ts';
import { audit } from '../audit.ts';
import { type AdminGuard, adminOf } from '../guard.ts';
import { canBan } from '../rbac.ts';
import { banView, eventView, pageOf, visitorProfile } from '../views.ts';

const params = z.object({ id: z.uuid() });

/** Bans, moderation events and visitor lookup. */
export const adminModerationRoutes: FastifyPluginAsyncZod<{
  prisma: PrismaClient;
  bans: BanService;
  guard: AdminGuard;
  clock: Clock;
  recordAction: (action: string) => void;
}> = (app, { prisma, bans, guard, clock, recordAction }) => {
  app.get(
    '/bans',
    {
      preHandler: guard('bans.read'),
      schema: { querystring: banQuerySchema, response: { 200: banPageSchema } },
    },
    async (request) => {
      const { visitorId, active, cursor, limit } = request.query;
      const now = clock.now();
      const rows = await prisma.ban.findMany({
        where: {
          ...(visitorId === undefined ? {} : { visitorId }),
          ...(active === true
            ? { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }
            : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
        include: { createdByAdmin: { select: { email: true } } },
      });
      const { items, nextCursor } = pageOf(rows, limit);
      return { items: items.map((ban) => banView(ban, now)), nextCursor };
    },
  );

  app.post(
    '/bans',
    {
      preHandler: guard('bans.create'),
      schema: { body: createBanSchema, response: { 200: okSchema } },
    },
    async (request) => {
      const admin = adminOf(request);
      const { visitorId, type, durationHours, reason } = request.body;
      if (!canBan(admin.role, { type, durationHours })) {
        throw new AppError(403, ErrorCode.FORBIDDEN, 'Moderators can hard-ban for at most 30 days');
      }
      const visitor = await prisma.visitor.findUnique({
        where: { id: visitorId },
        select: { deviceIdHash: true },
      });
      if (visitor === null) throw new AppError(404, ErrorCode.NOT_FOUND, 'Visitor not found');
      const now = clock.now();
      await bans.apply(
        {
          visitorId,
          deviceIdHash: visitor.deviceIdHash,
          type,
          reason,
          expiresAt:
            durationHours === null ? null : new Date(now.getTime() + durationHours * 3_600_000),
          createdByAdminId: admin.id,
        },
        {
          audit: (tx, banId) =>
            audit(tx, {
              adminId: admin.id,
              action: 'ban.create',
              targetType: 'visitor',
              targetId: visitorId,
              metadata: { banId, type, durationHours },
            }),
        },
      );
      recordAction(type === 'HARD' ? 'ban_hard' : 'ban_shadow');
      return { ok: true as const };
    },
  );

  app.post(
    '/bans/:id/revoke',
    { preHandler: guard('bans.revoke'), schema: { params, response: { 200: okSchema } } },
    async (request) => {
      const admin = adminOf(request);
      const revoked = await bans.revoke(request.params.id, admin.id, {
        audit: (tx) =>
          audit(tx, {
            adminId: admin.id,
            action: 'ban.revoke',
            targetType: 'ban',
            targetId: request.params.id,
          }),
      });
      if (!revoked) throw new AppError(404, ErrorCode.NOT_FOUND, 'No active ban with this id');
      recordAction('ban_revoke');
      return { ok: true as const };
    },
  );

  app.get(
    '/moderation-events',
    {
      preHandler: guard('events.read'),
      schema: { querystring: eventQuerySchema, response: { 200: eventPageSchema } },
    },
    async (request) => {
      const { source, visitorId, cursor, limit } = request.query;
      const rows = await prisma.moderationEvent.findMany({
        where: {
          ...(source === undefined ? {} : { source }),
          ...(visitorId === undefined ? {} : { visitorId }),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
      });
      const { items, nextCursor } = pageOf(rows, limit);
      return { items: items.map(eventView), nextCursor };
    },
  );

  app.get(
    '/visitors/:id',
    {
      preHandler: guard('visitors.read'),
      schema: { params, response: { 200: visitorProfileSchema } },
    },
    async (request) => {
      const profile = await visitorProfile(prisma, request.params.id, clock.now());
      if (profile === null) throw new AppError(404, ErrorCode.NOT_FOUND, 'Visitor not found');
      return profile;
    },
  );

  return Promise.resolve();
};
