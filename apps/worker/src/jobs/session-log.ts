import { type LeaveReason as DbLeaveReason, type PrismaClient } from '@app/db';
import { type Logger } from '@app/logger';
import { type LeaveReason, type SessionLogJob } from '@app/shared/jobs';

// Compile-time guard: the job contract's reasons must equal the database enum.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
export type LeaveReasonsMatch = Assert<Exact<LeaveReason, DbLeaveReason>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Persists session metadata (never content). Idempotent: re-running the same job updates the
 * same rows, so BullMQ retries and duplicate deliveries are harmless. Participants whose visitor
 * no longer exists (deleted, or synthetic in tests) are skipped rather than failing the job.
 */
export async function persistSessionLog(
  prisma: PrismaClient,
  job: SessionLogJob,
  logger: Pick<Logger, 'warn'>,
): Promise<{ participants: number; skipped: number }> {
  const candidateIds = [...new Set(job.participants.map((p) => p.visitorId))].filter((id) =>
    UUID.test(id),
  );
  const known = new Set(
    (
      await prisma.visitor.findMany({ where: { id: { in: candidateIds } }, select: { id: true } })
    ).map((visitor) => visitor.id),
  );
  const participants = job.participants.filter((p) => known.has(p.visitorId));
  const skipped = job.participants.length - participants.length;
  if (skipped > 0) logger.warn({ sessionId: job.sessionId, skipped }, 'unknown visitors skipped');

  const session = {
    mode: job.mode === 'video' ? ('VIDEO' as const) : ('TEXT' as const),
    topology: job.topology === 'sfu' ? ('SFU' as const) : ('MESH' as const),
    maxParticipants: job.maxParticipants,
    commonInterests: job.commonInterests,
    startedAt: new Date(job.startedAt),
    endedAt: new Date(job.endedAt),
  };

  await prisma.$transaction([
    prisma.chatSessionLog.upsert({
      where: { id: job.sessionId },
      create: { id: job.sessionId, ...session },
      update: session,
    }),
    ...participants.map((p) => {
      const fields = {
        visitorId: p.visitorId,
        joinedAt: new Date(p.joinedAt),
        leftAt: p.leftAt === null ? null : new Date(p.leftAt),
        leaveReason: p.leaveReason,
      };
      return prisma.sessionParticipant.upsert({
        where: {
          sessionId_participantId: { sessionId: job.sessionId, participantId: p.participantId },
        },
        create: { sessionId: job.sessionId, participantId: p.participantId, ...fields },
        update: fields,
      });
    }),
  ]);

  return { participants: participants.length, skipped };
}
