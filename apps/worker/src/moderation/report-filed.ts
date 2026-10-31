import { trustDelta } from '@app/moderation';
import { type ReportFiledJob } from '@app/shared/jobs';

import { DAY_MS, type ModerationDeps } from './deps.ts';

/**
 * `report-filed`: the reported visitor loses trust and is sampled at the `high` tier for a
 * day; once `reportThreshold` distinct people reported them within 24 h, they are
 * shadow-banned automatically (pending human review in Part 9).
 */
export async function handleReportFiled(
  deps: ModerationDeps,
  job: ReportFiledJob,
): Promise<{ reporters: number; shadowBanned: boolean }> {
  const { prisma, config } = deps;
  const at = new Date(job.at);
  await deps.trust.adjust(job.reportedId, trustDelta('report_received'));
  await deps.risk.reported(job.reportedId, at.getTime());
  await deps.risk.flag(job.reportedId, at.getTime() + DAY_MS);

  const reporters = (
    await prisma.report.findMany({
      where: {
        reportedId: job.reportedId,
        reporterId: { not: null },
        createdAt: { gte: new Date(at.getTime() - DAY_MS) },
      },
      distinct: ['reporterId'],
      select: { reporterId: true },
    })
  ).length;
  if (reporters < config.reportThreshold) return { reporters, shadowBanned: false };

  const alreadyBanned = await prisma.ban.count({
    where: {
      visitorId: job.reportedId,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: at } }],
    },
  });
  if (alreadyBanned > 0) return { reporters, shadowBanned: false };

  const visitor = await prisma.visitor.findUnique({
    where: { id: job.reportedId },
    select: { deviceIdHash: true },
  });
  await prisma.moderationEvent.create({
    data: {
      visitorId: job.reportedId,
      sessionId: job.sessionId,
      source: 'REPORT_THRESHOLD',
      label: 'distinct_reporters',
      score: Math.min(1, reporters / config.reportThreshold),
      actionTaken: 'SHADOW_BANNED',
    },
  });
  await deps.bans.apply({
    visitorId: job.reportedId,
    ...(visitor === null ? {} : { deviceIdHash: visitor.deviceIdHash }),
    type: 'SHADOW',
    reason: `auto: ${String(reporters)} reports in 24 h`,
    expiresAt: new Date(at.getTime() + config.autoBanHours * 3_600_000),
  });
  deps.logger.info({ visitorId: job.reportedId, reporters }, 'report threshold reached');
  return { reporters, shadowBanned: true };
}
