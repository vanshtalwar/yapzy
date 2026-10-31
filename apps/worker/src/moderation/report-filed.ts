import { trustDelta } from '@app/moderation';
import { reportPenaltyKey, reportThresholdLockKey } from '@app/redis';
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
  const at = new Date(job.at);
  // Every report stays for review, but one reporter costs the reported visitor trust (and
  // flags them) at most once a day: repeated reports from one person aren't extra evidence.
  const firstFromReporter =
    job.reporterId === undefined ||
    (await deps.redis.set(
      reportPenaltyKey(job.reporterId, job.reportedId),
      job.reportId,
      'EX',
      DAY_MS / 1_000,
      'NX',
    )) === 'OK';
  if (firstFromReporter) {
    await deps.trust.adjust(job.reportedId, trustDelta('report_received'));
    await deps.risk.reported(job.reportedId, at.getTime());
    await deps.risk.flag(job.reportedId, at.getTime() + DAY_MS);
  }

  // Worker replicas may process two reports against the same visitor at once: serialize the
  // threshold check and the ban (a busy lock fails the job; BullMQ retries it with backoff and
  // the per-reporter key above keeps the retry from charging trust twice).
  const lock = reportThresholdLockKey(job.reportedId);
  if ((await deps.redis.set(lock, job.reportId, 'PX', 30_000, 'NX')) !== 'OK') {
    throw new Error('report threshold check busy for this visitor; retrying');
  }
  try {
    return await checkThreshold(deps, job, at);
  } finally {
    if ((await deps.redis.get(lock)) === job.reportId) await deps.redis.del(lock);
  }
}

async function checkThreshold(
  deps: ModerationDeps,
  job: ReportFiledJob,
  at: Date,
): Promise<{ reporters: number; shadowBanned: boolean }> {
  const { prisma, config } = deps;
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
  deps.observer?.action('report_threshold', 'shadow_banned');
  return { reporters, shadowBanned: true };
}
