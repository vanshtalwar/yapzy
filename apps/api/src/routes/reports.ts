import { createHash } from 'node:crypto';

import { type PrismaClient } from '@app/db';
import { type ApiEnv } from '@app/env';
import { type BanChecker, EVIDENCE_RETENTION_DAYS, reportPriority } from '@app/moderation';
import {
  ErrorCode,
  REPORT_FRAME_MAX_BYTES,
  REPORT_MAX_FRAMES,
  reportFieldsSchema,
  reportResponseSchema,
} from '@app/shared';
import { type ObjectStore } from '@app/storage';
import multipart from '@fastify/multipart';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

import { type Clock } from '../deps.ts';
import { AppError } from '../errors.ts';
import { type ApiMetrics } from '../metrics.ts';
import { InvalidImageError, sanitizeJpeg } from '../services/images.ts';
import { type ApiJobs } from '../services/jobs.ts';
import { type SessionState } from '../services/session-state.ts';

export const REPORT_RATE_LIMIT = { max: 10, timeWindow: '1 hour' } as const;

const DAY_MS = 24 * 60 * 60 * 1000;

interface ReportDeps {
  config: ApiEnv;
  prisma: PrismaClient;
  objects: ObjectStore;
  jobs: ApiJobs;
  sessions: SessionState;
  clock: Clock;
  metrics: ApiMetrics;
  bans: BanChecker;
}

/**
 * `POST /v1/reports` (multipart): fields + up to 3 JPEG frames the reporter's browser kept in
 * memory. Both sides must have been in the session (its keys live 1 h after the end); the
 * reported visitor is resolved server-side. Evidence: re-encoded frames in the evidence bucket
 * and the transcript snapshot in the report row.
 */
export const reportRoutes: FastifyPluginAsyncZod<ReportDeps> = async (app, deps) => {
  const { config, prisma, objects, jobs, sessions, clock, metrics, bans } = deps;
  await app.register(multipart, {
    limits: {
      fileSize: REPORT_FRAME_MAX_BYTES,
      files: REPORT_MAX_FRAMES,
      fields: 8,
      fieldSize: 2_000,
      parts: REPORT_MAX_FRAMES + 8,
    },
  });

  app.post(
    '/v1/reports',
    {
      onRequest: [app.authenticate],
      // 200 = this chat was already reported by this visitor (idempotent), 201 = new report.
      schema: { response: { 200: reportResponseSchema, 201: reportResponseSchema } },
      config: {
        rateLimit: {
          ...REPORT_RATE_LIMIT,
          hook: 'preHandler',
          keyGenerator: (request) => request.visitor?.id ?? 'anonymous',
        },
      },
    },
    async (request, reply) => {
      const visitor = request.visitor;
      if (visitor === null) throw new AppError(401, ErrorCode.UNAUTHORIZED, 'Missing bearer token');
      if (!request.isMultipart()) {
        throw new AppError(400, ErrorCode.VALIDATION_FAILED, 'Expected multipart/form-data');
      }

      const fields: Record<string, string> = {};
      const uploads: Buffer[] = [];
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          if (part.fieldname !== 'frames') {
            await part.toBuffer(); // drain
            throw new AppError(400, ErrorCode.VALIDATION_FAILED, 'Unexpected file field');
          }
          uploads.push(await part.toBuffer()); // throws 413 past REPORT_FRAME_MAX_BYTES
        } else if (typeof part.value === 'string') {
          fields[part.fieldname] = part.value;
        }
      }
      const parsed = reportFieldsSchema.safeParse(fields);
      if (!parsed.success) {
        throw new AppError(400, ErrorCode.VALIDATION_FAILED, 'Invalid report', {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        });
      }
      const { sessionId, reportedParticipantId, reason, details } = parsed.data;

      // Only people who were really in that chat, about someone else in it.
      const participants = await sessions.participants(sessionId);
      const reporterIn = [...participants.values()].some((p) => p.visitorId === visitor.id);
      const reported = participants.get(reportedParticipantId);
      if (!reporterIn || reported === undefined || reported.visitorId === visitor.id) {
        throw new AppError(403, ErrorCode.FORBIDDEN, 'You can only report people you chatted with');
      }
      // A HARD-banned visitor's token stays valid until it expires; it must not be usable to
      // retaliate against whoever reported them.
      if ((await bans.findActiveBan({ visitorId: visitor.id }))?.type === 'HARD') {
        throw new AppError(403, ErrorCode.BANNED, 'Access denied');
      }
      const existing = await prisma.report.findFirst({
        where: { reporterId: visitor.id, sessionId, reportedParticipantId },
        select: { id: true },
      });
      if (existing !== null) return reply.status(200).send({ reportId: existing.id });

      // Decoded only now: people outside the chat can't make the API decode images.
      const frames: Buffer[] = [];
      for (const bytes of uploads) {
        try {
          frames.push(await sanitizeJpeg(bytes));
        } catch (error) {
          if (error instanceof InvalidImageError) {
            throw new AppError(400, ErrorCode.VALIDATION_FAILED, error.message);
          }
          throw error;
        }
      }

      const roleOf = (participantId: string) =>
        participantId === reportedParticipantId
          ? 'reported'
          : participants.get(participantId)?.visitorId === visitor.id
            ? 'reporter'
            : 'other';
      const transcript = (await sessions.transcript(sessionId)).map((entry) => ({
        id: entry.id,
        at: entry.at,
        from: roleOf(entry.from),
        text: entry.text,
      }));

      const now = clock.now();
      const recent = await prisma.report.count({
        where: {
          reportedId: reported.visitorId,
          createdAt: { gte: new Date(now.getTime() - DAY_MS) },
        },
      });
      const report = await prisma.report.create({
        data: {
          sessionId,
          reporterId: visitor.id,
          reportedId: reported.visitorId,
          reportedParticipantId,
          reason,
          details: details === undefined || details === '' ? null : details,
          priority: reportPriority(reason, recent),
          transcript,
        },
        select: { id: true },
      });

      const expiresAt = new Date(now.getTime() + EVIDENCE_RETENTION_DAYS * DAY_MS);
      await Promise.all(
        frames.map(async (frame, index) => {
          const storageKey = `reports/${report.id}/${String(index + 1)}.jpg`;
          await objects.put(config.S3_BUCKET_EVIDENCE, storageKey, frame, 'image/jpeg');
          await prisma.evidence.create({
            data: {
              reportId: report.id,
              type: 'FRAME',
              storageKey,
              sha256: createHash('sha256').update(frame).digest('hex'),
              expiresAt,
            },
          });
        }),
      );

      await jobs.reportFiled({
        reportId: report.id,
        reportedId: reported.visitorId,
        reporterId: visitor.id,
        sessionId,
        at: now.toISOString(),
      });
      metrics.reports.inc({ reason, source: 'user' });
      request.log.info({ reportId: report.id, reason, frames: frames.length }, 'report filed');
      return reply.status(201).send({ reportId: report.id });
    },
  );
};
