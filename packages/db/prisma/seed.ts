/**
 * Development seed — idempotent (fixed ids + upserts), safe to run repeatedly.
 * Every seeded row is recognisable as dev data: ids start with 00000000-0000-7000-8000-,
 * free-text fields start with "[seed]", device ids are "seed-device-N" before hashing and
 * IPs come from the 198.51.100.0/24 documentation range.
 */
import { createEnv, seedEnv } from '@app/env';
import { createLogger } from '@app/logger';
import { hmacHash } from '@app/shared/crypto';
import { hash, verify } from '@node-rs/argon2';

import { createPrismaClient } from '../src/client.ts';
import { type Prisma } from '../src/generated/prisma/client.ts';

const env = createEnv(seedEnv, { service: 'seed' });
const log = createLogger({ service: 'seed', level: env.LOG_LEVEL, nodeEnv: env.NODE_ENV });

if (env.NODE_ENV === 'production') {
  log.fatal('refusing to seed development data with NODE_ENV=production');
  process.exit(1);
}

const db = createPrismaClient({ databaseUrl: env.DATABASE_URL, maxConnections: 2 });

const seedId = (suffix: string) => `00000000-0000-7000-8000-${suffix.padStart(12, '0')}`;
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

async function seedAdmin(): Promise<void> {
  const email = env.SEED_ADMIN_EMAIL.toLowerCase();
  const existing = await db.adminUser.findUnique({ where: { email } });
  // argon2 hashes are salted, so only re-hash when the configured password changed.
  if (existing !== null && (await verify(existing.passwordHash, env.SEED_ADMIN_PASSWORD))) {
    log.info({ adminId: existing.id }, 'dev admin unchanged');
    return;
  }
  const passwordHash = await hash(env.SEED_ADMIN_PASSWORD); // argon2id (library default)
  const admin = await db.adminUser.upsert({
    where: { email },
    create: { id: seedId('ad01'), email, passwordHash, role: 'ADMIN' },
    update: { passwordHash, role: 'ADMIN', disabledAt: null },
  });
  log.info({ adminId: admin.id }, 'dev admin created/updated');
}

const visitors = [
  { n: 1, trustScore: 50, country: 'US' },
  { n: 2, trustScore: 45, country: 'DE' },
  { n: 3, trustScore: 15, country: 'IN' }, // shadow-banned spammer below
  { n: 4, trustScore: 60, country: null },
] as const;

const visitorId = (n: number) => seedId(`a${String(n).padStart(3, '0')}`);

async function seedVisitors(): Promise<void> {
  for (const visitor of visitors) {
    const data = {
      deviceIdHash: hmacHash(`seed-device-${String(visitor.n)}`, env.DEVICE_HASH_PEPPER),
      lastIpHash: hmacHash(`198.51.100.${String(visitor.n)}`, env.IP_HASH_PEPPER),
      ageConfirmedAt: minutesAgo(60),
      tosVersion: 'seed',
      trustScore: visitor.trustScore,
      country: visitor.country,
    };
    await db.visitor.upsert({
      where: { id: visitorId(visitor.n) },
      create: { id: visitorId(visitor.n), ...data },
      update: data,
    });
  }
}

const sessions = [
  {
    id: seedId('5e01'),
    mode: 'VIDEO',
    commonInterests: ['music'],
    startedMinutesAgo: 30,
    participants: [
      { participantId: 'seedP1a', n: 1, leaveReason: 'STOP' },
      { participantId: 'seedP1b', n: 2, leaveReason: 'REPORTED' },
    ],
  },
  {
    id: seedId('5e02'),
    mode: 'TEXT',
    commonInterests: [],
    startedMinutesAgo: 20,
    participants: [
      { participantId: 'seedP2a', n: 3, leaveReason: 'SKIP' },
      { participantId: 'seedP2b', n: 4, leaveReason: 'REPORTED' },
    ],
  },
] as const;

async function seedSessions(): Promise<void> {
  for (const session of sessions) {
    const startedAt = minutesAgo(session.startedMinutesAgo);
    const endedAt = minutesAgo(session.startedMinutesAgo - 4);
    const data = {
      mode: session.mode,
      commonInterests: [...session.commonInterests],
      startedAt,
      endedAt,
    };
    await db.chatSessionLog.upsert({
      where: { id: session.id },
      create: { id: session.id, ...data },
      update: data,
    });
    for (const participant of session.participants) {
      const fields = {
        visitorId: visitorId(participant.n),
        joinedAt: startedAt,
        leftAt: endedAt,
        leaveReason: participant.leaveReason,
      };
      await db.sessionParticipant.upsert({
        where: {
          sessionId_participantId: {
            sessionId: session.id,
            participantId: participant.participantId,
          },
        },
        create: { sessionId: session.id, participantId: participant.participantId, ...fields },
        update: fields,
      });
    }
  }
}

function transcript(lines: [from: string, text: string][]): Prisma.InputJsonValue {
  return lines.map(([from, text], index) => ({
    id: `seed-msg-${String(index + 1)}`,
    from,
    text: `[seed] ${text}`,
    at: minutesAgo(25 - index).toISOString(),
  }));
}

async function seedReports(): Promise<void> {
  const reports: (Prisma.ReportUncheckedCreateInput & { id: string })[] = [
    {
      id: seedId('7e01'),
      sessionId: seedId('5e01'),
      reporterId: visitorId(1),
      reportedId: visitorId(2),
      reportedParticipantId: 'seedP1b',
      reason: 'HARASSMENT',
      details: '[seed] Insults after a few messages.',
      priority: 20,
      transcript: transcript([
        ['seedP1a', 'hi, where are you from?'],
        ['seedP1b', 'sample insult (placeholder text)'],
      ]),
    },
    {
      id: seedId('7e02'),
      sessionId: seedId('5e02'),
      reporterId: visitorId(4),
      reportedId: visitorId(3),
      reportedParticipantId: 'seedP2a',
      reason: 'SPAM_SCAM',
      details: '[seed] Keeps posting a link.',
      priority: 10,
      transcript: transcript([['seedP2a', 'check out example.invalid for free stuff']]),
    },
    {
      id: seedId('7e03'),
      sessionId: seedId('5e01'),
      reporterId: visitorId(2),
      reportedId: visitorId(1),
      reportedParticipantId: 'seedP1a',
      reason: 'OTHER',
      details: '[seed] Retaliatory report, dismissed.',
      status: 'DISMISSED',
      resolvedAt: minutesAgo(5),
      resolutionNote: '[seed] No violation found.',
    },
  ];
  for (const { id, ...data } of reports) {
    await db.report.upsert({ where: { id }, create: { id, ...data }, update: data });
  }
}

async function seedModerationAndBan(): Promise<void> {
  const eventData = {
    visitorId: visitorId(3),
    sessionId: seedId('5e02'),
    source: 'TEXT_FILTER',
    label: 'spam_link',
    score: 0.92,
    actionTaken: 'SHADOW_BANNED',
  } as const;
  await db.moderationEvent.upsert({
    where: { id: seedId('3e01') },
    create: { id: seedId('3e01'), ...eventData },
    update: eventData,
  });

  const banData = {
    visitorId: visitorId(3),
    deviceIdHash: hmacHash('seed-device-3', env.DEVICE_HASH_PEPPER),
    type: 'SHADOW',
    reason: '[seed] Repeated spam links (automated).',
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
    revokedAt: null,
  } as const;
  await db.ban.upsert({
    where: { id: seedId('ba01') },
    create: { id: seedId('ba01'), ...banData },
    update: banData,
  });
}

try {
  await seedAdmin();
  await seedVisitors();
  await seedSessions();
  await seedReports();
  await seedModerationAndBan();
  log.info('seed complete');
} finally {
  await db.$disconnect();
}
