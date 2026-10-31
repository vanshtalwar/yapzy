import { isCleanSession, trustDelta } from '@app/moderation';
import { type SessionLogJob } from '@app/shared/jobs';

import { DAY_MS, type ModerationDeps } from './deps.ts';

/**
 * After a session: +1 trust for a violation-free stay of ≥ 60 s; −5 and the `high` tier for a
 * day if the participant uploaded less than half of the frames the server asked for (D-054:
 * blocking uploads must not be a way to avoid checks). Spot checks (≤ 1 frame) are exempt.
 */
export async function applySessionTrust(
  deps: ModerationDeps,
  job: SessionLogJob,
  known: Set<string>,
): Promise<{ clean: number; missingFrames: number }> {
  const endedAt = Date.parse(job.endedAt);
  let clean = 0;
  let missingFrames = 0;
  for (const participant of job.participants) {
    if (!known.has(participant.visitorId)) continue;
    const stayedMs =
      (participant.leftAt === null ? endedAt : Date.parse(participant.leftAt)) -
      Date.parse(participant.joinedAt);
    const violations = await deps.prisma.moderationEvent.count({
      where: {
        visitorId: participant.visitorId,
        sessionId: job.sessionId,
        source: { in: ['TEXT_FILTER', 'SERVER_CLASSIFIER', 'HASH_MATCH'] },
      },
    });
    if (isCleanSession({ durationMs: stayedMs, violations })) {
      await deps.trust.adjust(participant.visitorId, trustDelta('clean_session'));
      clean += 1;
    }

    const frames = participant.frames;
    if (frames?.intervalMs == null) continue;
    const expected = Math.min(
      frames.maxFrames ?? Number.POSITIVE_INFINITY,
      Math.floor(stayedMs / frames.intervalMs),
    );
    if (expected >= 2 && frames.received < expected / 2) {
      await deps.trust.adjust(participant.visitorId, trustDelta('missing_frames'));
      await deps.risk.flag(participant.visitorId, endedAt + DAY_MS);
      missingFrames += 1;
      deps.logger.info(
        { visitorId: participant.visitorId, expected, received: frames.received },
        'moderation frames missing',
      );
    }
  }
  return { clean, missingFrames };
}
