import { type Prisma, type PrismaClient } from '@app/db';
import { type ApiEnv } from '@app/env';
import { type BanService, type CreatedBan, type TrustStore } from '@app/moderation';
import {
  ErrorCode,
  okSchema,
  reportActionSchema,
  reportDetailSchema,
  reportDismissSchema,
  reportNoteSchema,
  reportPageSchema,
  reportQuerySchema,
  transcriptLineSchema,
} from '@app/shared';
import { type ObjectStore } from '@app/storage';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { type Clock } from '../../deps.ts';
import { AppError } from '../../errors.ts';
import { audit } from '../audit.ts';
import { type AdminGuard, adminOf } from '../guard.ts';
import { canBan } from '../rbac.ts';
import { pageOf, visitorProfile } from '../views.ts';

/** Presigned evidence URLs are valid this long (moderator opened the report just now). */
export const EVIDENCE_URL_TTL_SECONDS = 5 * 60;

const params = z.object({ id: z.uuid() });
const transcriptSchema = z.array(transcriptLineSchema).catch([]);

export interface ReportRouteDeps {
  config: ApiEnv;
  prisma: PrismaClient;
  objects: ObjectStore;
  bans: BanService;
  trust: TrustStore;
  guard: AdminGuard;
  clock: Clock;
}

export const adminReportRoutes: FastifyPluginAsyncZod<ReportRouteDeps> = (app, deps) => {
  const { config, prisma, objects, bans, trust, guard, clock } = deps;

  async function load(id: string) {
    const report = await prisma.report.findUnique({ where: { id } });
    if (report === null) throw new AppError(404, ErrorCode.NOT_FOUND, 'Report not found');
    return report;
  }

  // Queue: highest priority first, oldest first within a priority.
  app.get(
    '/reports',
    {
      preHandler: guard('reports.read'),
      schema: { querystring: reportQuerySchema, response: { 200: reportPageSchema } },
    },
    async (request) => {
      const { status, reason, minPriority, from, to, cursor, limit } = request.query;
      const rows = await prisma.report.findMany({
        where: {
          ...(status === undefined ? {} : { status }),
          ...(reason === undefined ? {} : { reason }),
          ...(minPriority === undefined ? {} : { priority: { gte: minPriority } }),
          ...(from === undefined && to === undefined
            ? {}
            : {
                createdAt: {
                  ...(from === undefined ? {} : { gte: new Date(from) }),
                  ...(to === undefined ? {} : { lte: new Date(to) }),
                },
              }),
        },
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
        take: limit + 1,
        ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
        include: {
          _count: { select: { evidence: true } },
          assignedTo: { select: { email: true } },
        },
      });
      const { items, nextCursor } = pageOf(rows, limit);
      return {
        nextCursor,
        items: items.map((report) => ({
          id: report.id,
          reason: report.reason,
          status: report.status,
          priority: report.priority,
          automatic: report.reporterId === null,
          reportedId: report.reportedId,
          evidenceCount: report._count.evidence,
          assignedTo: report.assignedTo?.email ?? null,
          createdAt: report.createdAt.toISOString(),
        })),
      };
    },
  );

  app.get(
    '/reports/:id',
    {
      preHandler: guard('reports.read'),
      schema: { params, response: { 200: reportDetailSchema } },
    },
    async (request) => {
      const admin = adminOf(request);
      const report = await prisma.report.findUnique({
        where: { id: request.params.id },
        include: {
          evidence: { orderBy: { storageKey: 'asc' } },
          assignedTo: { select: { email: true } },
        },
      });
      if (report === null) throw new AppError(404, ErrorCode.NOT_FOUND, 'Report not found');
      const now = clock.now();
      const [reporter, reported] = await Promise.all([
        report.reporterId === null ? null : visitorProfile(prisma, report.reporterId, now),
        visitorProfile(prisma, report.reportedId, now),
      ]);
      if (reported === null)
        throw new AppError(404, ErrorCode.NOT_FOUND, 'Reported visitor is gone');
      // Only this report's evidence is ever signed.
      const evidence = await Promise.all(
        report.evidence.map(async (item) => ({
          id: item.id,
          type: item.type,
          sha256: item.sha256,
          url: await objects
            .presignGet(config.S3_BUCKET_EVIDENCE, item.storageKey, EVIDENCE_URL_TTL_SECONDS)
            .catch(() => null),
          expiresAt: item.expiresAt?.toISOString() ?? null,
        })),
      );
      if (evidence.length > 0) {
        await prisma.$transaction((tx) =>
          audit(tx, {
            adminId: admin.id,
            action: 'report.view_evidence',
            targetType: 'report',
            targetId: report.id,
          }),
        );
      }
      return {
        id: report.id,
        reason: report.reason,
        status: report.status,
        priority: report.priority,
        automatic: report.reporterId === null,
        reportedId: report.reportedId,
        evidenceCount: evidence.length,
        assignedTo: report.assignedTo?.email ?? null,
        createdAt: report.createdAt.toISOString(),
        sessionId: report.sessionId,
        reportedParticipantId: report.reportedParticipantId,
        details: report.details,
        transcript: transcriptSchema.parse(report.transcript ?? []),
        evidence,
        resolutionNote: report.resolutionNote,
        resolvedAt: report.resolvedAt?.toISOString() ?? null,
        reporter,
        reported,
      };
    },
  );

  app.post(
    '/reports/:id/assign',
    { preHandler: guard('reports.review'), schema: { params, response: { 200: okSchema } } },
    async (request) => {
      const admin = adminOf(request);
      const report = await load(request.params.id);
      await prisma.$transaction(async (tx) => {
        await tx.report.update({
          where: { id: report.id },
          data: {
            assignedToId: admin.id,
            ...(report.status === 'OPEN' ? { status: 'IN_REVIEW' } : {}),
          },
        });
        await audit(tx, {
          adminId: admin.id,
          action: 'report.assign',
          targetType: 'report',
          targetId: report.id,
        });
      });
      return { ok: true as const };
    },
  );

  app.post(
    '/reports/:id/dismiss',
    {
      preHandler: guard('reports.review'),
      schema: { params, body: reportDismissSchema, response: { 200: okSchema } },
    },
    async (request) => {
      const admin = adminOf(request);
      const report = await load(request.params.id);
      await prisma.$transaction(async (tx) => {
        await tx.report.update({
          where: { id: report.id },
          data: {
            status: 'DISMISSED',
            resolvedAt: clock.now(),
            assignedToId: admin.id,
            resolutionNote: request.body.note ?? report.resolutionNote,
          },
        });
        await audit(tx, {
          adminId: admin.id,
          action: 'report.dismiss',
          targetType: 'report',
          targetId: report.id,
          metadata: { note: request.body.note ?? null },
        });
      });
      return { ok: true as const };
    },
  );

  app.post(
    '/reports/:id/note',
    {
      preHandler: guard('reports.review'),
      schema: { params, body: reportNoteSchema, response: { 200: okSchema } },
    },
    async (request) => {
      const admin = adminOf(request);
      const report = await load(request.params.id);
      const stamped = `[${clock.now().toISOString()} ${admin.email}] ${request.body.note}`;
      const note = [report.resolutionNote, stamped].filter(Boolean).join('\n').slice(-2_000);
      await prisma.$transaction(async (tx) => {
        await tx.report.update({ where: { id: report.id }, data: { resolutionNote: note } });
        await audit(tx, {
          adminId: admin.id,
          action: 'report.note',
          targetType: 'report',
          targetId: report.id,
        });
      });
      return { ok: true as const };
    },
  );

  /** Resolve with consequences: ban and/or trust change, all audited in one transaction. */
  app.post(
    '/reports/:id/action',
    {
      preHandler: guard('reports.review'),
      schema: { params, body: reportActionSchema, response: { 200: okSchema } },
    },
    async (request) => {
      const admin = adminOf(request);
      const { ban, trustDelta, note } = request.body;
      if (ban !== undefined && !canBan(admin.role, ban)) {
        throw new AppError(403, ErrorCode.FORBIDDEN, 'Moderators can hard-ban for at most 30 days');
      }
      const report = await load(request.params.id);
      const now = clock.now();
      const outcome = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.report.update({
          where: { id: report.id },
          data: {
            status: 'ACTIONED',
            resolvedAt: now,
            assignedToId: admin.id,
            ...(note === undefined || note === '' ? {} : { resolutionNote: note }),
          },
        });
        let created: CreatedBan | null = null;
        if (ban !== undefined) {
          const visitor = await tx.visitor.findUnique({
            where: { id: report.reportedId },
            select: { deviceIdHash: true },
          });
          created = await bans.create(tx, {
            visitorId: report.reportedId,
            ...(visitor === null ? {} : { deviceIdHash: visitor.deviceIdHash }),
            type: ban.type,
            reason: `report ${report.id} (${report.reason})`,
            expiresAt:
              ban.durationHours === null
                ? null
                : new Date(now.getTime() + ban.durationHours * 3_600_000),
            createdByAdminId: admin.id,
          });
        }
        const score =
          trustDelta === undefined ? null : await trust.adjust(report.reportedId, trustDelta, tx);
        await audit(tx, {
          adminId: admin.id,
          action: 'report.action',
          targetType: 'report',
          targetId: report.id,
          metadata: {
            ban: ban ?? null,
            banId: created?.banId ?? null,
            trustDelta: trustDelta ?? null,
            reportedId: report.reportedId,
          },
        });
        return { created, score };
      });
      // After the commit: caches and `ban_applied` (gateways end live sessions at once).
      if (outcome.score !== null) await trust.cache(report.reportedId, outcome.score);
      if (outcome.created !== null) await bans.activate(outcome.created);
      return { ok: true as const };
    },
  );

  return Promise.resolve();
};
