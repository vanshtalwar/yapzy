import { createHash } from 'node:crypto';

import { EVIDENCE_RETENTION_DAYS, flaggedLabel, reportPriority, trustDelta } from '@app/moderation';
import { sessionKeys } from '@app/redis';
import { type ReportReason } from '@app/shared';
import { type ClassifyFrameJob } from '@app/shared/jobs';

import { DAY_MS, type ModerationDeps } from './deps.ts';

export type ClassifyOutcome = 'missing' | 'clean' | 'flagged' | 'hash_match';

const REASON_BY_LABEL: Record<string, ReportReason> = {
  sexual_explicit: 'NUDITY_SEXUAL',
  sexual_minor_risk: 'MINOR_SAFETY',
  violence_graphic: 'VIOLENCE_SELF_HARM',
};

/** Automatic reports are reviewed before user reports of the same reason. */
const AUTO_REPORT_BOOST = 20;
/** Known-CSAM matches go to the very top of the queue. */
const HASH_MATCH_PRIORITY = 1_000;

/** The chat's transcript, each line by role and sender (like user reports, Part 12). */
async function transcriptOf(deps: ModerationDeps, sessionId: string, reportedId: string) {
  const raw = await deps.redis.lrange(sessionKeys(sessionId).log, 0, -1);
  return raw.flatMap((json) => {
    try {
      const entry = JSON.parse(json) as { id?: string; at?: string; from?: string; text?: string };
      return [
        {
          id: entry.id,
          at: entry.at,
          from: entry.from === reportedId ? 'reported' : 'other',
          participantId: entry.from,
          text: entry.text,
        },
      ];
    } catch {
      return [];
    }
  });
}

/**
 * `classify-frame`: hash matching first, then the image classifier. Clean frames are deleted
 * at once (the bucket's 1-day lifecycle is only a backstop). A flagged frame becomes evidence
 * of a moderation event and an automatic report; trust drops, the visitor is sampled at the
 * `high` tier for a day, and above the auto-ban score they are shadow-banned (HARD ban +
 * escalation for hash matches). Every ban goes through BanService → `ban_applied`.
 */
export async function classifyFrame(
  deps: ModerationDeps,
  job: ClassifyFrameJob,
): Promise<ClassifyOutcome> {
  const { prisma, objects, buckets, config, logger } = deps;
  const now = deps.now?.() ?? new Date();
  const frame = await objects.get(buckets.frames, job.storageKey);
  if (frame === null) return 'missing';

  const hash = await deps.hashMatcher.match(frame);
  const label = hash.matched
    ? { name: `hash_match:${hash.list}`, score: 1 }
    : flaggedLabel(
        (await deps.classifier.classify(frame, { visitorId: job.visitorId })).labels,
        config.flagThreshold,
      );
  if (label === null) {
    await objects.delete(buckets.frames, job.storageKey);
    return 'clean';
  }

  const shadowBan = !hash.matched && label.score >= config.autoShadowScore;
  const action = hash.matched ? 'ESCALATED' : shadowBan ? 'SHADOW_BANNED' : 'TRUST_DECREASED';
  const event = await prisma.moderationEvent.create({
    data: {
      visitorId: job.visitorId,
      sessionId: job.sessionId,
      source: hash.matched ? 'HASH_MATCH' : 'SERVER_CLASSIFIER',
      label: label.name.slice(0, 64),
      score: label.score,
      actionTaken: action,
    },
    select: { id: true },
  });

  // Keep the frame as evidence (outside the frames bucket's 1-day lifecycle).
  const evidenceKey = `auto/${event.id}.jpg`;
  await objects.copy(
    { bucket: buckets.frames, key: job.storageKey },
    { bucket: buckets.evidence, key: evidenceKey },
  );
  await objects.delete(buckets.frames, job.storageKey);

  const reason = hash.matched ? 'MINOR_SAFETY' : (REASON_BY_LABEL[label.name] ?? 'OTHER');
  const recent = await prisma.report.count({
    where: { reportedId: job.visitorId, createdAt: { gte: new Date(now.getTime() - DAY_MS) } },
  });
  const report = await prisma.report.create({
    data: {
      sessionId: job.sessionId,
      reporterId: null,
      reportedId: job.visitorId,
      reportedParticipantId: job.participantId,
      reason,
      details: `Automatic: ${label.name} (${label.score.toFixed(2)})`,
      priority: hash.matched
        ? HASH_MATCH_PRIORITY
        : reportPriority(reason, recent) + AUTO_REPORT_BOOST,
      transcript: await transcriptOf(deps, job.sessionId, job.participantId),
    },
    select: { id: true },
  });
  await prisma.evidence.create({
    data: {
      reportId: report.id,
      moderationEventId: event.id,
      type: 'AUTO_FLAG_FRAME',
      storageKey: evidenceKey,
      sha256: createHash('sha256').update(frame).digest('hex'),
      // Hash matches are preserved for the legal report; nothing expires them automatically.
      expiresAt: hash.matched ? null : new Date(now.getTime() + EVIDENCE_RETENTION_DAYS * DAY_MS),
    },
  });

  await deps.trust.adjust(job.visitorId, trustDelta('auto_flag'));
  await deps.risk.flag(job.visitorId, now.getTime() + DAY_MS);

  if (hash.matched || shadowBan) {
    const visitor = await prisma.visitor.findUnique({
      where: { id: job.visitorId },
      select: { deviceIdHash: true },
    });
    await deps.bans.apply({
      visitorId: job.visitorId,
      ...(visitor === null ? {} : { deviceIdHash: visitor.deviceIdHash }),
      type: hash.matched ? 'HARD' : 'SHADOW',
      reason: `auto: ${label.name} (report ${report.id})`,
      expiresAt: hash.matched ? null : new Date(now.getTime() + config.autoBanHours * 3_600_000),
    });
  }
  deps.observer?.action(hash.matched ? 'hash_match' : 'server_classifier', action.toLowerCase());
  deps.observer?.autoReport(reason);
  logger.info(
    { reportId: report.id, eventId: event.id, label: label.name, action },
    'frame flagged',
  );
  return hash.matched ? 'hash_match' : 'flagged';
}
