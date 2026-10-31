import { trustDelta } from '@app/moderation';
import { type ModerationEventJob } from '@app/shared/jobs';

import { type ModerationDeps } from './deps.ts';

/**
 * `moderation-event`: persists what the gateway saw (blocked text, client NSFW signals) and
 * applies its trust change. Client signals carry no trust change: a malicious client could
 * otherwise lower other people's trust; they only raise sampling for the session.
 */
export async function recordModerationEvent(
  deps: ModerationDeps,
  job: ModerationEventJob,
): Promise<'recorded' | 'unknown_visitor'> {
  const exists = await deps.prisma.visitor.count({ where: { id: job.visitorId } });
  if (exists === 0) return 'unknown_visitor';
  await deps.prisma.moderationEvent.create({
    data: {
      visitorId: job.visitorId,
      sessionId: job.sessionId,
      source: job.source,
      label: job.label,
      score: job.score,
      actionTaken: job.action,
      createdAt: new Date(job.at),
    },
  });
  if (job.trustEvent !== null) await deps.trust.adjust(job.visitorId, trustDelta(job.trustEvent));
  return 'recorded';
}
