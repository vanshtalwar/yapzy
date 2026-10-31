import { type PrismaClient } from '@app/db';
import { type Logger } from '@app/logger';
import {
  BAN_CACHE_MAX_TTL_SECONDS,
  BAN_CACHE_NEGATIVE_TTL_SECONDS,
  type BanCacheEntry,
  banCacheEntrySchema,
  banDeviceKey,
  banIpKey,
  banVisitorKey,
  getJson,
  type Redis,
  setJson,
} from '@app/redis';

export interface ActiveBan {
  banId: string;
  type: 'HARD' | 'SHADOW';
  /** ISO timestamp; null = permanent. */
  expiresAt: string | null;
}

/** Callers pass what they know: the API has all three, the gateway has visitor id + IP hash. */
export interface BanIdentifiers {
  visitorId: string;
  deviceIdHash?: string;
  ipHash?: string;
}

export interface BanChecker {
  /** Most severe active ban matching any identifier (HARD before SHADOW, permanent first). */
  findActiveBan(ids: BanIdentifiers): Promise<ActiveBan | null>;
}

type Identifier = keyof BanIdentifiers;

interface Target {
  identifier: Identifier;
  value: string;
  key: string;
}

function severity(ban: ActiveBan): [number, number] {
  const expiry = ban.expiresAt === null ? Number.POSITIVE_INFINITY : Date.parse(ban.expiresAt);
  return [ban.type === 'HARD' ? 1 : 0, expiry];
}

function mostSevere(bans: ActiveBan[]): ActiveBan | null {
  let best: ActiveBan | null = null;
  for (const ban of bans) {
    if (best === null) {
      best = ban;
      continue;
    }
    const [typeA, expiryA] = severity(ban);
    const [typeB, expiryB] = severity(best);
    if (typeA > typeB || (typeA === typeB && expiryA > expiryB)) best = ban;
  }
  return best;
}

function targetsOf(ids: BanIdentifiers): Target[] {
  const targets: Target[] = [
    { identifier: 'visitorId', value: ids.visitorId, key: banVisitorKey(ids.visitorId) },
  ];
  if (ids.deviceIdHash !== undefined) {
    targets.push({
      identifier: 'deviceIdHash',
      value: ids.deviceIdHash,
      key: banDeviceKey(ids.deviceIdHash),
    });
  }
  if (ids.ipHash !== undefined) {
    targets.push({ identifier: 'ipHash', value: ids.ipHash, key: banIpKey(ids.ipHash) });
  }
  return targets;
}

function cacheEntryFor(ban: ActiveBan | null, now: Date): { entry: BanCacheEntry; ttl: number } {
  if (ban === null) {
    return { entry: { banned: false }, ttl: BAN_CACHE_NEGATIVE_TTL_SECONDS };
  }
  const secondsLeft =
    ban.expiresAt === null
      ? BAN_CACHE_MAX_TTL_SECONDS
      : Math.ceil((Date.parse(ban.expiresAt) - now.getTime()) / 1000);
  return {
    entry: { banned: true, ...ban },
    ttl: Math.max(1, Math.min(secondsLeft, BAN_CACHE_MAX_TTL_SECONDS)),
  };
}

/**
 * Postgres is the source of truth; Redis `ban:*` keys cache both positive and negative results
 * per identifier (CONTEXT.md D-026). Redis failures degrade to Postgres-only, never to
 * "not banned" without a check.
 */
export function createBanChecker(deps: {
  prisma: PrismaClient;
  redis: Redis;
  logger: Pick<Logger, 'warn'>;
  now?: () => Date;
}): BanChecker {
  const { prisma, redis, logger, now: clock = () => new Date() } = deps;

  async function readCache(targets: Target[]): Promise<(BanCacheEntry | null)[]> {
    try {
      return await Promise.all(targets.map(({ key }) => getJson(redis, key, banCacheEntrySchema)));
    } catch (error) {
      logger.warn({ err: error }, 'ban cache read failed; falling back to Postgres');
      return targets.map(() => null);
    }
  }

  return {
    async findActiveBan(ids) {
      const now = clock();
      const targets = targetsOf(ids);

      const cached = await readCache(targets);
      if (cached.every((entry) => entry !== null)) {
        const active = cached.flatMap((entry) =>
          entry.banned && (entry.expiresAt === null || Date.parse(entry.expiresAt) > now.getTime())
            ? [{ banId: entry.banId, type: entry.type, expiresAt: entry.expiresAt }]
            : [],
        );
        return mostSevere(active);
      }

      const rows = await prisma.ban.findMany({
        where: {
          revokedAt: null,
          AND: [
            { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
            { OR: targets.map(({ identifier, value }) => ({ [identifier]: value })) },
          ],
        },
        select: {
          id: true,
          type: true,
          expiresAt: true,
          visitorId: true,
          deviceIdHash: true,
          ipHash: true,
        },
      });

      const toBan = (row: (typeof rows)[number]): ActiveBan => ({
        banId: row.id,
        type: row.type,
        expiresAt: row.expiresAt?.toISOString() ?? null,
      });

      try {
        await Promise.all(
          targets.map(({ identifier, value, key }) => {
            const ban = mostSevere(rows.filter((row) => row[identifier] === value).map(toBan));
            const { entry, ttl } = cacheEntryFor(ban, now);
            return setJson(redis, key, banCacheEntrySchema, entry, { ttlSeconds: ttl });
          }),
        );
      } catch (error) {
        logger.warn({ err: error }, 'ban cache write failed');
      }

      return mostSevere(rows.map(toBan));
    },
  };
}
