import { type PrismaClient } from '@app/db';
import { type BanView, type ModerationEventView, type VisitorProfile } from '@app/shared';

const DAY_MS = 24 * 60 * 60 * 1000;

interface BanRow {
  id: string;
  visitorId: string | null;
  type: 'HARD' | 'SHADOW';
  reason: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  createdByAdmin?: { email: string } | null;
}

export function banView(ban: BanRow, now: Date): BanView {
  return {
    active: ban.revokedAt === null && (ban.expiresAt === null || ban.expiresAt > now),
    id: ban.id,
    visitorId: ban.visitorId,
    type: ban.type,
    reason: ban.reason,
    expiresAt: ban.expiresAt?.toISOString() ?? null,
    revokedAt: ban.revokedAt?.toISOString() ?? null,
    createdAt: ban.createdAt.toISOString(),
    createdBy: ban.createdByAdmin?.email ?? null,
  };
}

export function eventView(event: {
  id: string;
  visitorId: string;
  sessionId: string | null;
  source: ModerationEventView['source'];
  label: string;
  score: number;
  actionTaken: string;
  createdAt: Date;
}): ModerationEventView {
  return { ...event, createdAt: event.createdAt.toISOString() };
}

/** Metadata-only profile of a visitor for moderators (never chat content). */
export async function visitorProfile(
  prisma: PrismaClient,
  visitorId: string,
  now: Date,
): Promise<VisitorProfile | null> {
  const visitor = await prisma.visitor.findUnique({ where: { id: visitorId } });
  if (visitor === null) return null;
  const [sessions, received, received30d, filed, bans, events, recent] = await Promise.all([
    prisma.sessionParticipant.count({ where: { visitorId } }),
    prisma.report.count({ where: { reportedId: visitorId } }),
    prisma.report.count({
      where: { reportedId: visitorId, createdAt: { gte: new Date(now.getTime() - 30 * DAY_MS) } },
    }),
    prisma.report.count({ where: { reporterId: visitorId } }),
    prisma.ban.findMany({
      where: { visitorId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: { createdByAdmin: { select: { email: true } } },
    }),
    prisma.moderationEvent.findMany({
      where: { visitorId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
    prisma.report.findMany({
      where: { reportedId: visitorId },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { id: true, reason: true, status: true, createdAt: true },
    }),
  ]);
  return {
    id: visitor.id,
    trustScore: visitor.trustScore,
    firstSeenAt: visitor.firstSeenAt.toISOString(),
    lastSeenAt: visitor.lastSeenAt.toISOString(),
    country: visitor.country,
    sessions,
    reportsReceived: received,
    reportsReceived30d: received30d,
    reportsFiled: filed,
    bans: bans.map((ban) => banView(ban, now)),
    events: events.map(eventView),
    recentReports: recent.map((report) => ({
      ...report,
      createdAt: report.createdAt.toISOString(),
    })),
  };
}

/** Cursor page from `take: limit + 1` results. */
export function pageOf<T extends { id: string }>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null };
}
