import { Prisma, type PrismaClient } from '@app/db';
import { EVIDENCE_RETENTION_DAYS } from '@app/moderation';
import { type ObjectStore } from '@app/storage';

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH = 100;

export interface RetentionDeps {
  prisma: PrismaClient;
  objects: ObjectStore;
  evidenceBucket: string;
  now: Date;
}

/**
 * Data retention (privacy): deletes evidence whose `expiresAt` passed (object first, then the
 * row, so a crash never leaves an object without its row), and clears the transcript of reports
 * closed more than EVIDENCE_RETENTION_DAYS ago. Evidence without `expiresAt` (hash matches,
 * kept for the legal process) is never touched. Idempotent; runs hourly.
 */
export async function purgeExpiredData(
  deps: RetentionDeps,
): Promise<{ evidence: number; transcripts: number }> {
  const { prisma, objects, evidenceBucket, now } = deps;
  let evidence = 0;
  for (;;) {
    const expired = await prisma.evidence.findMany({
      where: { expiresAt: { lt: now } },
      select: { id: true, storageKey: true },
      orderBy: { expiresAt: 'asc' },
      take: BATCH,
    });
    if (expired.length === 0) break;
    for (const row of expired) await objects.delete(evidenceBucket, row.storageKey);
    await prisma.evidence.deleteMany({ where: { id: { in: expired.map((row) => row.id) } } });
    evidence += expired.length;
    if (expired.length < BATCH) break;
  }

  const closedBefore = new Date(now.getTime() - EVIDENCE_RETENTION_DAYS * DAY_MS);
  const { count: transcripts } = await prisma.report.updateMany({
    where: {
      status: { in: ['ACTIONED', 'DISMISSED'] },
      resolvedAt: { lt: closedBefore },
      transcript: { not: Prisma.DbNull },
    },
    data: { transcript: Prisma.DbNull },
  });
  return { evidence, transcripts };
}
