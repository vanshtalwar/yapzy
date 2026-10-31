import { assertBanHasTarget, type PrismaClient } from '@app/db';
import { type Logger } from '@app/logger';
import {
  banDeviceKey,
  banIpKey,
  banVisitorKey,
  GW_CONTROL_CHANNEL,
  publishControl,
  type Redis,
} from '@app/redis';

import { type ActiveBan, createBanChecker } from './bans.ts';

export interface BanRequest {
  visitorId?: string;
  deviceIdHash?: string;
  ipHash?: string;
  type: 'HARD' | 'SHADOW';
  reason: string;
  /** null = permanent. */
  expiresAt: Date | null;
  /** null/undefined = automated ban. */
  createdByAdminId?: string;
}

export interface BanServiceDeps {
  prisma: PrismaClient;
  redis: Redis;
  logger: Pick<Logger, 'warn' | 'info'>;
  /** Who publishes `ban_applied` (e.g. "worker", "api"); shows up in gateway logs. */
  originNodeId: string;
  /** Tests only: pub/sub ignores the DB index. */
  controlChannel?: string;
  now?: () => Date;
}

/**
 * The only way bans should be written (D-026): Postgres row → refresh the Redis ban cache
 * for every identifier → `ban_applied` on `gw:control`, so every gateway node acts on live
 * sockets immediately (HARD: disconnect; SHADOW: end the chat, shadow pool from now on).
 */
export function createBanService(deps: BanServiceDeps) {
  const { prisma, redis, logger } = deps;
  const checker = createBanChecker({
    prisma,
    redis,
    logger,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });

  /** Drops cached results so the next check reads Postgres (then caches the most severe). */
  async function invalidate(ids: {
    visitorId?: string | null;
    deviceIdHash?: string | null;
    ipHash?: string | null;
  }) {
    const keys = [
      ids.visitorId == null ? null : banVisitorKey(ids.visitorId),
      ids.deviceIdHash == null ? null : banDeviceKey(ids.deviceIdHash),
      ids.ipHash == null ? null : banIpKey(ids.ipHash),
    ].filter((key): key is string => key !== null);
    if (keys.length > 0) await redis.del(...keys);
  }

  return {
    async apply(request: BanRequest): Promise<{ banId: string; active: ActiveBan | null }> {
      assertBanHasTarget(request);
      // A device ban also reaches the visitor currently using that device (the gateway only
      // knows visitor ids and IP hashes of live sockets).
      let visitorId = request.visitorId;
      if (visitorId === undefined && request.deviceIdHash !== undefined) {
        const owner = await prisma.visitor.findUnique({
          where: { deviceIdHash: request.deviceIdHash },
          select: { id: true },
        });
        visitorId = owner?.id;
      }

      const ban = await prisma.ban.create({
        data: {
          visitorId: visitorId ?? null,
          deviceIdHash: request.deviceIdHash ?? null,
          ipHash: request.ipHash ?? null,
          type: request.type,
          reason: request.reason.slice(0, 500),
          expiresAt: request.expiresAt,
          createdByAdminId: request.createdByAdminId ?? null,
        },
      });

      await invalidate({ visitorId, deviceIdHash: request.deviceIdHash, ipHash: request.ipHash });
      const active =
        visitorId === undefined
          ? null
          : await checker.findActiveBan({
              visitorId,
              ...(request.deviceIdHash === undefined ? {} : { deviceIdHash: request.deviceIdHash }),
              ...(request.ipHash === undefined ? {} : { ipHash: request.ipHash }),
            });

      await publishControl(
        redis,
        {
          type: 'ban_applied',
          originNodeId: deps.originNodeId,
          banId: ban.id,
          banType: request.type,
          ...(visitorId === undefined ? {} : { visitorId }),
          ...(request.deviceIdHash === undefined ? {} : { deviceIdHash: request.deviceIdHash }),
          ...(request.ipHash === undefined ? {} : { ipHash: request.ipHash }),
          expiresAt: request.expiresAt?.toISOString() ?? null,
        },
        deps.controlChannel ?? GW_CONTROL_CHANNEL,
      );
      logger.info({ banId: ban.id, type: request.type, visitorId }, 'ban applied');
      return { banId: ban.id, active };
    },

    /** Lifts a ban (admin, Part 9): the cache is dropped so it takes effect on the next check. */
    async revoke(banId: string, revokedByAdminId?: string): Promise<boolean> {
      const ban = await prisma.ban.findUnique({ where: { id: banId } });
      if (ban?.revokedAt !== null) return false; // unknown, or already revoked
      await prisma.ban.update({
        where: { id: banId },
        data: { revokedAt: new Date(), revokedByAdminId: revokedByAdminId ?? null },
      });
      await invalidate(ban);
      return true;
    },
  };
}

export type BanService = ReturnType<typeof createBanService>;
