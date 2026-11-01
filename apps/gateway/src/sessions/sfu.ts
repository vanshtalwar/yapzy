import { type Logger } from '@app/logger';
import {
  type BookedRoom,
  JANUS_TOKEN_TTL_SECONDS,
  newRoomId,
  type RoomBook,
  roomSecret,
  type SfuRegistry,
  signJanusToken,
} from '@app/sfu';
import { type ServerToClientEvents, type SfuJoin } from '@app/shared';

import { type GatewayMetrics } from '../metrics.ts';
import { type SessionContext, type SessionStore, type SfuPlacement } from './store.ts';

export interface SfuConfig {
  adminSecret: string;
  tokenSecret: string;
  publisherBitrate: number;
  upgradeTimeoutMs: number;
}

export interface SfuOrchestratorDeps {
  store: SessionStore;
  registry: SfuRegistry;
  book: RoomBook;
  config: SfuConfig;
  emitTo: <E extends keyof ServerToClientEvents>(
    visitorId: string,
    event: E,
    ...args: Parameters<ServerToClientEvents[E]>
  ) => void;
  logger: Pick<Logger, 'debug' | 'info' | 'warn'>;
  metrics: Pick<GatewayMetrics, 'sfuUpgrades' | 'sfuUpgradeDuration' | 'sfuFailovers'>;
  clock: () => number;
  /** A switch to Janus finished (`true`) or was rolled back (`false`) — Part 12 seeks after it. */
  onUpgradeSettled?: (sessionId: string, upgraded: boolean) => void;
}

export type UpgradeOutcome =
  'started' | 'already' | 'upgrading' | 'not_active' | 'not_video' | 'unavailable';

interface OpenedRoom {
  placement: SfuPlacement;
  /** participantId → token (also in the room's allowed list). */
  tokens: Map<string, string>;
}

const presentOf = (context: SessionContext) =>
  [...context.participants].filter(([, record]) => record.status !== 'left');

/**
 * Janus orchestration for the gateway (Part 11): room placement, the make-before-break
 * mesh → SFU switch (upgrade → every participant confirms → stable; timeout or failure →
 * rollback, P2P keeps running), removing people who leave, failover to another node, and
 * token refresh. Session state lives in Redis (store), so any node can continue what another
 * node started — including the upgrade deadline.
 */
export function createSfuOrchestrator(deps: SfuOrchestratorDeps) {
  const { store, registry, book, config, logger, metrics, clock } = deps;
  const secretOf = (placement: SfuPlacement) =>
    roomSecret(config.adminSecret, placement.nodeId, placement.roomId);

  /** A fresh signed token (10 min); unique, so allowed-list entries are per participant. */
  function newToken(): string {
    return signJanusToken({
      secret: config.tokenSecret,
      expiresAt: Math.floor(clock() / 1_000) + JANUS_TOKEN_TTL_SECONDS,
    });
  }

  function joinInfo(placement: SfuPlacement, token: string, epoch: number): SfuJoin | null {
    const node = registry.node(placement.nodeId);
    return node === undefined
      ? null
      : { wsUrl: node.wsUrl, roomId: placement.roomId, token, epoch };
  }

  /**
   * A room on the least-loaded healthy node with one token per participant. Booked BEFORE it
   * exists on Janus, so the orphan sweep never destroys a room being created.
   */
  async function openRoom(
    sessionId: string,
    participantIds: string[],
    exclude?: string,
  ): Promise<OpenedRoom | null> {
    if (!registry.enabled) return null;
    const node = await registry.pickNode(exclude === undefined ? {} : { exclude });
    if (node === null) {
      logger.warn({ sessionId }, 'no healthy Janus node for a room');
      return null;
    }
    const placement: SfuPlacement = { nodeId: node.id, roomId: newRoomId() };
    const tokens = new Map(participantIds.map((participantId) => [participantId, newToken()]));
    await book.add(node.id, placement.roomId, { sessionId, createdAt: clock() });
    try {
      await registry.admin(node.id).createRoom({
        roomId: placement.roomId,
        secret: secretOf(placement),
        allowed: [...tokens.values()],
        bitrate: config.publisherBitrate,
      });
    } catch (error) {
      await book.remove(node.id, placement.roomId).catch(() => undefined);
      logger.warn({ err: error, sessionId, janusNode: node.id }, 'creating a Janus room failed');
      return null;
    }
    return { placement, tokens };
  }

  /** Destroys a room and unbooks it; if Janus can't be reached, the orphan sweep retries. */
  async function closeRoom(placement: SfuPlacement): Promise<void> {
    try {
      await registry.admin(placement.nodeId).destroyRoom(placement.roomId, secretOf(placement));
    } catch (error) {
      logger.warn({ err: error, janusNode: placement.nodeId }, 'destroying a Janus room failed');
      return;
    }
    await book.remove(placement.nodeId, placement.roomId);
  }

  /** `call:topology` (sfu) to every present participant, each with their own token. */
  function announceRoom(
    sessionId: string,
    context: SessionContext,
    epoch: number,
    opened: OpenedRoom,
  ): void {
    for (const [participantId, record] of presentOf(context)) {
      const token = opened.tokens.get(participantId);
      const join = token === undefined ? null : joinInfo(opened.placement, token, epoch);
      if (join === null) continue;
      deps.emitTo(record.visitorId, 'call:topology', {
        sessionId,
        topology: 'sfu',
        epoch,
        sfu: { wsUrl: join.wsUrl, roomId: join.roomId, token: join.token },
      });
    }
  }

  async function rollback(
    sessionId: string,
    epoch: number,
    reason: 'timeout' | 'failed' | 'unavailable',
  ): Promise<boolean> {
    const result = await store.rollbackUpgrade(sessionId, epoch);
    if (result === null) return false;
    await store.removeDeadlines([{ kind: 'upgrade', sessionId, epoch }]);
    if (result.room !== null) await closeRoom(result.room);
    metrics.sfuUpgrades.inc({ outcome: reason === 'unavailable' ? 'unavailable' : 'rolled_back' });
    const context = await store.context(sessionId);
    if (context?.state === 'active') {
      for (const [, record] of presentOf(context)) {
        deps.emitTo(record.visitorId, 'call:topology', {
          sessionId,
          topology: 'mesh',
          epoch,
          reason,
        });
      }
    }
    logger.info({ sessionId, epoch, reason }, 'sfu upgrade rolled back');
    deps.onUpgradeSettled?.(sessionId, false);
    return true;
  }

  return {
    get enabled(): boolean {
      return registry.enabled;
    },

    openRoom,
    closeRoom,
    joinInfo,
    newToken,

    /**
     * Starts the mesh → sfu switch (make-before-break): room with a token per participant,
     * `call:topology` to everyone, and a deadline: if not everyone confirms with
     * `call:topologyReady` in time, the switch is rolled back and P2P simply continues.
     */
    async upgrade(sessionId: string): Promise<UpgradeOutcome> {
      if (!registry.enabled) return 'unavailable';
      const begun = await store.beginUpgrade(sessionId, clock());
      if (begun.status !== 'started') return begun.status;
      const { epoch } = begun;
      metrics.sfuUpgrades.inc({ outcome: 'started' });
      const context = await store.context(sessionId);
      if (context === null) return 'not_active';
      // The deadline goes in first: even if this node dies right now, another one rolls back.
      await store.addDeadline(
        { kind: 'upgrade', sessionId, epoch },
        clock() + config.upgradeTimeoutMs,
      );
      const opened = await openRoom(
        sessionId,
        presentOf(context).map(([participantId]) => participantId),
      );
      if (opened === null) {
        await rollback(sessionId, epoch, 'unavailable');
        return 'unavailable';
      }
      if (!(await store.assignRoom(sessionId, epoch, opened.placement, opened.tokens))) {
        await closeRoom(opened.placement); // the session ended meanwhile
        return 'not_active';
      }
      announceRoom(sessionId, context, epoch, opened);
      logger.info({ sessionId, epoch, janusNode: opened.placement.nodeId }, 'sfu upgrade started');
      return 'started';
    },

    /** `call:topologyReady`: once everyone confirmed, an upgrade is complete (topology=sfu). */
    async ready(sessionId: string, participantId: string, epoch: number): Promise<void> {
      const result = await store.markTopologyReady(sessionId, participantId, epoch);
      if (result.status !== 'complete') return; // others still switching, or an old epoch
      await store.removeDeadlines([{ kind: 'upgrade', sessionId, epoch }]);
      if (!result.upgraded) return; // a failover's new room: nothing else changes
      metrics.sfuUpgrades.inc({ outcome: 'succeeded' });
      metrics.sfuUpgradeDuration.observe(Math.max(0, clock() - result.upgradeStartedAt) / 1_000);
      logger.info({ sessionId, epoch }, 'sfu upgrade complete');
      deps.onUpgradeSettled?.(sessionId, true);
    },

    rollback,

    /** Upgrade deadline (any node): still not confirmed by everyone → back to P2P only. */
    async upgradeExpired(sessionId: string, epoch: number): Promise<void> {
      await rollback(sessionId, epoch, 'timeout');
    },

    /**
     * After a leave (`context` read afterwards). The session ended → destroy its room.
     * Otherwise the leaver's token leaves the allowed list and their publisher is kicked —
     * kick alone would let them rejoin.
     */
    async afterLeave(
      context: SessionContext,
      participantId: string,
      ended: boolean,
    ): Promise<void> {
      const room = context.sfu;
      if (room === null) return;
      if (ended) {
        await closeRoom(room);
        return;
      }
      const admin = registry.admin(room.nodeId);
      const secret = secretOf(room);
      const token = context.participants.get(participantId)?.sfuToken;
      if (token !== undefined) await admin.allowTokens(room.roomId, secret, 'remove', [token]);
      for (const member of await admin.listParticipants(room.roomId)) {
        if (member.display === participantId) await admin.kick(room.roomId, secret, member.id);
      }
    },

    /**
     * Failover (health leader): calls whose room is lost — node unhealthy, or the room vanished
     * (Janus restarted) — move to a new room on another node (`call:topology`, epoch + 1;
     * clients rejoin, a few seconds of interruption). A switch still in progress is rolled
     * back instead: its P2P call is still running.
     */
    async failover(rooms: BookedRoom[]): Promise<void> {
      for (const lost of rooms) {
        const context = await store.context(lost.sessionId);
        const current = context?.sfu ?? null;
        const isCurrent =
          context?.state === 'active' &&
          current?.nodeId === lost.nodeId &&
          current.roomId === lost.roomId;
        if (context === null || !isCurrent) {
          await book.remove(lost.nodeId, lost.roomId); // stale booking; nothing to move
          continue;
        }
        if (context.topologyState === 'upgrading') {
          await rollback(lost.sessionId, context.topologyEpoch, 'failed');
          metrics.sfuFailovers.inc({ outcome: 'rolled_back' });
          continue;
        }
        const epoch = await store.beginMove(lost.sessionId, current);
        if (epoch === null) continue;
        const opened = await openRoom(
          lost.sessionId,
          presentOf(context).map(([participantId]) => participantId),
          lost.nodeId,
        );
        if (opened === null) {
          metrics.sfuFailovers.inc({ outcome: 'failed' }); // retried on the next health tick
          continue;
        }
        if (!(await store.assignRoom(lost.sessionId, epoch, opened.placement, opened.tokens))) {
          await closeRoom(opened.placement);
          continue;
        }
        await book.remove(lost.nodeId, lost.roomId);
        announceRoom(lost.sessionId, context, epoch, opened);
        metrics.sfuFailovers.inc({ outcome: 'moved' });
        logger.info(
          { sessionId: lost.sessionId, from: lost.nodeId, to: opened.placement.nodeId, epoch },
          'sfu failover: call moved',
        );
      }
    },

    /** Is this booked room still the current room of a live session? (orphan sweep) */
    async inUse(room: BookedRoom): Promise<boolean> {
      const context = await store.context(room.sessionId);
      return (
        context?.state === 'active' &&
        context.sfu?.nodeId === room.nodeId &&
        context.sfu.roomId === room.roomId
      );
    },
  };
}

export type SfuOrchestrator = ReturnType<typeof createSfuOrchestrator>;
