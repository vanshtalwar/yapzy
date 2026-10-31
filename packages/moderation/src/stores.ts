import { type PrismaClient } from '@app/db';
import {
  getJson,
  type Redis,
  RISK_PROFILE_TTL_SECONDS,
  type RiskProfileEntry,
  riskProfileEntrySchema,
  riskProfileKey,
  setJson,
  TRUST_CACHE_TTL_SECONDS,
  trustKey,
} from '@app/redis';

import { type RiskProfile } from './sampling.ts';
import { clampTrust, TRUST_DEFAULT } from './trust.ts';

/**
 * Trust scores: Postgres (`Visitor.trustScore`) is the source of truth, `trust:<id>` caches it
 * for the hot path (gateway pool + sampling decisions never touch Postgres).
 */
export function createTrustStore(deps: { prisma: PrismaClient; redis: Redis }) {
  const { prisma, redis } = deps;

  async function cache(visitorId: string, score: number): Promise<void> {
    await redis.set(trustKey(visitorId), String(score), 'EX', TRUST_CACHE_TTL_SECONDS);
  }

  return {
    cache,

    /** Cached score, else Postgres (re-cached); unknown visitors count as the default. */
    async get(visitorId: string): Promise<number> {
      const cached = await redis.get(trustKey(visitorId));
      if (cached !== null && Number.isFinite(Number(cached))) return Number(cached);
      const visitor = await prisma.visitor.findUnique({
        where: { id: visitorId },
        select: { trustScore: true },
      });
      const score = visitor?.trustScore ?? TRUST_DEFAULT;
      await cache(visitorId, score);
      return score;
    },

    /** Atomic clamped update in Postgres, then the cache. null if the visitor is gone. */
    async adjust(visitorId: string, delta: number): Promise<number | null> {
      if (delta === 0) return this.get(visitorId);
      const rows = await prisma.$queryRaw<{ trust_score: number }[]>`
        UPDATE visitors
        SET trust_score = LEAST(100, GREATEST(0, trust_score + ${Math.round(delta)})),
            updated_at = now()
        WHERE id = ${visitorId}::uuid
        RETURNING trust_score`;
      const score = rows[0]?.trust_score;
      if (score === undefined) return null;
      await cache(visitorId, clampTrust(score));
      return score;
    },
  };
}

export type TrustStore = ReturnType<typeof createTrustStore>;

/** `risk:<visitorId>`: first seen + recent flags/reports, for the gateway's sampling tier. */
export function createRiskProfiles(deps: { redis: Redis }) {
  const { redis } = deps;
  const empty: RiskProfileEntry = { firstSeenAt: null, flaggedUntil: null, lastReportedAt: null };

  async function read(visitorId: string): Promise<RiskProfileEntry> {
    return (await getJson(redis, riskProfileKey(visitorId), riskProfileEntrySchema)) ?? empty;
  }

  async function merge(visitorId: string, change: Partial<RiskProfileEntry>): Promise<void> {
    const next = { ...(await read(visitorId)), ...change };
    await setJson(redis, riskProfileKey(visitorId), riskProfileEntrySchema, next, {
      ttlSeconds: RISK_PROFILE_TTL_SECONDS,
    });
  }

  return {
    read,

    /** Full profile for tier selection (trust read separately from its own cache). */
    async profile(visitorId: string, trust: number): Promise<RiskProfile> {
      return { trust, ...(await read(visitorId)) };
    },

    seen(visitorId: string, firstSeenAt: Date): Promise<void> {
      return merge(visitorId, { firstSeenAt: firstSeenAt.getTime() });
    },

    /** Sampled at the `high` tier until `until` (after a report or an automatic flag). */
    async flag(visitorId: string, until: number): Promise<void> {
      const current = await read(visitorId);
      await merge(visitorId, { flaggedUntil: Math.max(until, current.flaggedUntil ?? 0) });
    },

    reported(visitorId: string, at: number): Promise<void> {
      return merge(visitorId, { lastReportedAt: at });
    },
  };
}

export type RiskProfiles = ReturnType<typeof createRiskProfiles>;
