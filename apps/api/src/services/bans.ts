import { type PrismaClient } from '@app/db';
import { type Logger } from '@app/logger';
import {
  BAN_CACHE_MAX_TTL_SECONDS,
  BAN_CACHE_NEGATIVE_TTL_SECONDS,
  banCacheEntrySchema,
  banDeviceKey,
  banIpKey,
  banVisitorKey,
  getJson,
  type Redis,
  setJson,
} from '@app/redis';

import { type Clock } from '../deps.ts';

export interface ActiveBan {
  banId: string;
  type: 'HARD' | 'SHADOW';
  /** ISO timestamp; null = permanent. */
  expiresAt: string | null;
}

export interface BanIdentifiers {
  visitorId: string;
  deviceIdHash: string;
  ipHash: string;
}

export interface BanChecker {
  /** Most severe active ban matching any identifier (HARD before SHADOW, permanent first). */
  findActiveBan(ids: BanIdentifiers): Promise<ActiveBan | null>;
}

type Identifier = 'visitorId' | 'deviceIdHash' | 'ipHash';

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

/**
 * Postgres is the source of truth; Redis `ban:*` keys cache both positive and negative results
 * per identifier. Redis failures degrade to Postgres-only, never to "not banned" without a check.
 */
export function createBanChecker(deps: {
  prisma: PrismaClient;
  redis: Redis;
  clock: Clock;
  logger: Pick<Logger, 'warn'>;
}): BanChecker {
  const { prisma, redis, clock, logger } = deps;

  async function readCache(keys: string[]) {
    try {
      return await Promise.all(keys.map((key) => getJson(redis, key, banCacheEntrySchema)));
    } catch (error) {
      logger.warn({ err: error }, 'ban cache read failed; falling back to Postgres');
      return keys.map(() => null);
    }
  }

  return {
    async findActiveBan(ids) {
      const now = clock.now();
      const keyOf: Record<Identifier, string> = {
        visitorId: banVisitorKey(ids.visitorId),
        deviceIdHash: banDeviceKey(ids.deviceIdHash),
        ipHash: banIpKey(ids.ipHash),
      };
      const identifiers = Object.keys(keyOf) as Identifier[];

      const cached = await readCache(identifiers.map((id) => keyOf[id]));
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
            {
              OR: [
                { visitorId: ids.visitorId },
                { deviceIdHash: ids.deviceIdHash },
                { ipHash: ids.ipHash },
              ],
            },
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
          identifiers.map((identifier) => {
            const ban = mostSevere(
              rows.filter((row) => row[identifier] === ids[identifier]).map(toBan),
            );
            if (ban === null) {
              return setJson(
                redis,
                keyOf[identifier],
                banCacheEntrySchema,
                { banned: false },
                {
                  ttlSeconds: BAN_CACHE_NEGATIVE_TTL_SECONDS,
                },
              );
            }
            const secondsLeft =
              ban.expiresAt === null
                ? BAN_CACHE_MAX_TTL_SECONDS
                : Math.ceil((Date.parse(ban.expiresAt) - now.getTime()) / 1000);
            return setJson(
              redis,
              keyOf[identifier],
              banCacheEntrySchema,
              { banned: true, ...ban },
              {
                ttlSeconds: Math.max(1, Math.min(secondsLeft, BAN_CACHE_MAX_TTL_SECONDS)),
              },
            );
          }),
        );
      } catch (error) {
        logger.warn({ err: error }, 'ban cache write failed');
      }

      return mostSevere(rows.map(toBan));
    },
  };
}
