import { type Logger } from '@app/logger';
import { type Redis } from '@app/redis';

import {
  holdHealthLock,
  type NodeHealth,
  releaseHealthLock,
  type SfuRegistry,
} from './registry.ts';
import { type BookedRoom, type RoomBook } from './rooms.ts';

export interface SfuHealthLoopDeps {
  redis: Redis;
  registry: SfuRegistry;
  book: RoomBook;
  /** This gateway's node id (lock owner). */
  owner: string;
  intervalMs?: number;
  /** While some node is failing, check this often instead (fast failover). */
  failingIntervalMs?: number;
  /**
   * Rooms whose calls must move (failover): their node is unhealthy, or the node is up but no
   * longer has the room (Janus restarted between two checks). Called on every leader tick
   * while such rooms are booked, so a failover interrupted by a leader change still happens.
   */
  onRoomsLost: (rooms: BookedRoom[]) => Promise<void>;
  /** A node changed between healthy and unhealthy (metrics, logs). */
  onTransition?: (nodeId: string, healthy: boolean) => void;
  logger: Pick<Logger, 'debug' | 'info' | 'warn'>;
  now?: () => number;
}

/** A booked room missing on its node is only "lost" after this (creation is two steps). */
const LOST_ROOM_GRACE_MS = 10_000;

/**
 * Health checks of every Janus node by ONE gateway at a time (`lock:sfu:health`, renewed by
 * its owner): every `intervalMs` (5 s), every second while a node fails. The leader writes
 * `sfu:nodes` and hands lost rooms to the gateway for failover. Every gateway runs the loop;
 * followers just retry for the lock.
 */
export function startSfuHealthLoop(deps: SfuHealthLoopDeps) {
  const now = deps.now ?? Date.now;
  const intervalMs = deps.intervalMs ?? 5_000;
  const failingIntervalMs = deps.failingIntervalMs ?? 1_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | null = null;
  let stopped = false;
  let leader = false;

  async function tick(): Promise<number> {
    leader = await holdHealthLock(deps.redis, deps.owner, intervalMs * 3);
    if (!leader) return intervalMs;

    const previous = await deps.registry.health();
    const current = new Map<string, NodeHealth>();
    const roomsOnNode = new Map<string, Set<number>>();
    await Promise.all(
      deps.registry.nodes.map(async (node) => {
        const before = previous.get(node.id);
        const { health: entry, roomIds } = await deps.registry.check(node.id, before);
        current.set(node.id, entry);
        await deps.registry.saveHealth(node.id, entry);
        if (roomIds !== null) roomsOnNode.set(node.id, new Set(roomIds));
        if ((before?.healthy ?? false) !== entry.healthy) {
          deps.onTransition?.(node.id, entry.healthy);
          deps.logger.info(
            { janusNode: node.id, healthy: entry.healthy },
            'janus node health changed',
          );
        }
      }),
    );

    const lost = (await deps.book.list()).filter((room) => {
      const entry = current.get(room.nodeId);
      if (entry === undefined) return false; // node no longer configured: the sweeper unbooks it
      if (!entry.healthy) return true;
      const rooms = roomsOnNode.get(room.nodeId);
      return (
        rooms !== undefined &&
        !rooms.has(room.roomId) &&
        now() - room.createdAt > LOST_ROOM_GRACE_MS
      );
    });
    if (lost.length > 0) await deps.onRoomsLost(lost);

    return [...current.values()].some((entry) => entry.failures > 0)
      ? failingIntervalMs
      : intervalMs;
  }

  function schedule(delayMs: number): void {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(run, delayMs);
    timer.unref();
  }

  function run(): void {
    if (stopped || running !== null) return;
    running = tick()
      .catch((error: unknown) => {
        deps.logger.warn({ err: error }, 'sfu health check failed');
        return intervalMs;
      })
      .then((next) => {
        running = null;
        schedule(next);
      });
  }

  run();

  return {
    isLeader: () => leader,

    /** Check now (e.g. an Admin API connection just closed). */
    checkNow(): void {
      if (running === null) schedule(0);
    },

    /** Waits for the current tick; hands the lock over so another gateway takes over at once. */
    async stop(): Promise<void> {
      stopped = true;
      clearTimeout(timer);
      await running;
      if (leader) await releaseHealthLock(deps.redis, deps.owner).catch(() => undefined);
    },
  };
}

export type SfuHealthLoop = ReturnType<typeof startSfuHealthLoop>;
