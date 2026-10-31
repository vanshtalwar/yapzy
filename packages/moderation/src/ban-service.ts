import { assertBanHasTarget, type Prisma, type PrismaClient } from '@app/db';
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

/** A committed ban row, before its cache refresh and `ban_applied`. */
export interface CreatedBan {
  banId: string;
  type: 'HARD' | 'SHADOW';
  expiresAt: Date | null;
  visitorId?: string;
  deviceIdHash?: string;
  ipHash?: string;
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

  /** The DB part of a ban (inside the caller's transaction). */
  async function create(tx: Prisma.TransactionClient, request: BanRequest): Promise<CreatedBan> {
    assertBanHasTarget(request);
    // A device ban also reaches the visitor currently using that device (the gateway only
    // knows visitor ids and IP hashes of live sockets).
    let visitorId = request.visitorId;
    if (visitorId === undefined && request.deviceIdHash !== undefined) {
      const owner = await tx.visitor.findUnique({
        where: { deviceIdHash: request.deviceIdHash },
        select: { id: true },
      });
      visitorId = owner?.id;
    }
    const ban = await tx.ban.create({
      data: {
        visitorId: visitorId ?? null,
        deviceIdHash: request.deviceIdHash ?? null,
        ipHash: request.ipHash ?? null,
        type: request.type,
        reason: request.reason.slice(0, 500),
        expiresAt: request.expiresAt,
        createdByAdminId: request.createdByAdminId ?? null,
      },
      select: { id: true },
    });
    return {
      banId: ban.id,
      type: request.type,
      expiresAt: request.expiresAt,
      ...(visitorId === undefined ? {} : { visitorId }),
      ...(request.deviceIdHash === undefined ? {} : { deviceIdHash: request.deviceIdHash }),
      ...(request.ipHash === undefined ? {} : { ipHash: request.ipHash }),
    };
  }

  /** After commit: refresh the cache and tell every gateway node (`ban_applied`). */
  async function activate(ban: CreatedBan): Promise<ActiveBan | null> {
    const { visitorId, deviceIdHash, ipHash } = ban;
    await invalidate({ visitorId, deviceIdHash, ipHash });
    const active =
      visitorId === undefined
        ? null
        : await checker.findActiveBan({
            visitorId,
            ...(deviceIdHash === undefined ? {} : { deviceIdHash }),
            ...(ipHash === undefined ? {} : { ipHash }),
          });
    await publishControl(
      redis,
      {
        type: 'ban_applied',
        originNodeId: deps.originNodeId,
        banId: ban.banId,
        banType: ban.type,
        ...(visitorId === undefined ? {} : { visitorId }),
        ...(deviceIdHash === undefined ? {} : { deviceIdHash }),
        ...(ipHash === undefined ? {} : { ipHash }),
        expiresAt: ban.expiresAt?.toISOString() ?? null,
      },
      deps.controlChannel ?? GW_CONTROL_CHANNEL,
    );
    logger.info({ banId: ban.banId, type: ban.type, visitorId }, 'ban applied');
    return active;
  }

  return {
    create,
    activate,

    /** Ban in its own transaction (optionally with an audit row), then activate it. */
    async apply(
      request: BanRequest,
      options: { audit?: (tx: Prisma.TransactionClient, banId: string) => Promise<void> } = {},
    ): Promise<{ banId: string; active: ActiveBan | null }> {
      const ban = await prisma.$transaction(async (tx) => {
        const created = await create(tx, request);
        await options.audit?.(tx, created.banId);
        return created;
      });
      return { banId: ban.banId, active: await activate(ban) };
    },

    /** Lifts a ban (admin): the cache is dropped so it takes effect on the next check. */
    async revoke(
      banId: string,
      revokedByAdminId?: string,
      options: { audit?: (tx: Prisma.TransactionClient) => Promise<void> } = {},
    ): Promise<boolean> {
      const ban = await prisma.$transaction(async (tx) => {
        const current = await tx.ban.findUnique({ where: { id: banId } });
        if (current?.revokedAt !== null) return null; // unknown, or already revoked
        await tx.ban.update({
          where: { id: banId },
          data: { revokedAt: new Date(), revokedByAdminId: revokedByAdminId ?? null },
        });
        await options.audit?.(tx);
        return current;
      });
      if (ban === null) return false;
      await invalidate(ban);
      return true;
    },
  };
}

export type BanService = ReturnType<typeof createBanService>;
