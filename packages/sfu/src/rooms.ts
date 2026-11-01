import { hgetallJson, hsetJson, type Redis, SFU_ROOMS_KEY, sfuRoomField } from '@app/redis';
import { z } from 'zod';

import { type SfuRegistry } from './registry.ts';
import { roomSecret } from './videoroom.ts';

export const roomEntrySchema = z.object({ sessionId: z.uuid(), createdAt: z.number().int() });
export type RoomEntry = z.output<typeof roomEntrySchema>;

export interface BookedRoom extends RoomEntry {
  nodeId: string;
  roomId: number;
}

/**
 * `sfu:rooms`: every room we created and its session. The entry is written BEFORE the room is
 * created on Janus and removed AFTER it is destroyed, so a room on a node without an entry
 * is always an orphan (never one being created right now).
 */
export function createRoomBook(redis: Redis) {
  return {
    async add(nodeId: string, roomId: number, entry: RoomEntry): Promise<void> {
      await hsetJson(redis, SFU_ROOMS_KEY, sfuRoomField(nodeId, roomId), roomEntrySchema, entry);
    },

    async remove(nodeId: string, roomId: number): Promise<void> {
      await redis.hdel(SFU_ROOMS_KEY, sfuRoomField(nodeId, roomId));
    },

    async list(): Promise<BookedRoom[]> {
      const all = await hgetallJson(redis, SFU_ROOMS_KEY, roomEntrySchema);
      return [...all].flatMap(([field, entry]) => {
        const separator = field.lastIndexOf(':');
        const roomId = Number(field.slice(separator + 1));
        if (separator <= 0 || !Number.isSafeInteger(roomId)) return [];
        return [{ nodeId: field.slice(0, separator), roomId, ...entry }];
      });
    },
  };
}

export type RoomBook = ReturnType<typeof createRoomBook>;

export interface OrphanSweepDeps {
  registry: SfuRegistry;
  book: RoomBook;
  adminSecret: string;
  /** Is this room still the current room of a live session? (The gateway knows sessions.) */
  inUse: (room: BookedRoom) => Promise<boolean>;
  /** Rooms younger than this are left alone (their session may not be written yet). */
  minAgeMs?: number;
  now?: () => number;
}

/**
 * Orphan rooms (sweeper): booked rooms whose session ended or moved on are destroyed and
 * unbooked; rooms on a reachable node that aren't booked at all are destroyed too. Rooms on an
 * unreachable node are unbooked without destroying (the node lost them with its memory).
 * Returns how many rooms were cleaned up.
 */
export async function sweepOrphanRooms(deps: OrphanSweepDeps): Promise<number> {
  const now = deps.now ?? Date.now;
  const minAgeMs = deps.minAgeMs ?? 30_000;
  const health = await deps.registry.health();
  const secretOf = (nodeId: string, roomId: number) => roomSecret(deps.adminSecret, nodeId, roomId);

  // Rooms on each reachable node FIRST, then the book: an entry is written before its room is
  // created, so any room listed here that the (later) book doesn't know is a real orphan.
  const onNodes: { nodeId: string; roomId: number }[] = [];
  for (const node of deps.registry.nodes) {
    if (health.get(node.id)?.healthy !== true) continue;
    try {
      for (const roomId of await deps.registry.admin(node.id).listRooms()) {
        onNodes.push({ nodeId: node.id, roomId });
      }
    } catch {
      // unreachable right now; looked at next sweep
    }
  }
  const booked = await deps.book.list();
  let cleaned = 0;

  for (const room of booked) {
    if (now() - room.createdAt < minAgeMs || (await deps.inUse(room))) continue;
    const reachable = health.get(room.nodeId)?.healthy === true;
    if (reachable && deps.registry.node(room.nodeId) !== undefined) {
      try {
        await deps.registry
          .admin(room.nodeId)
          .destroyRoom(room.roomId, secretOf(room.nodeId, room.roomId));
      } catch {
        continue; // retried next sweep
      }
    }
    await deps.book.remove(room.nodeId, room.roomId);
    cleaned += 1;
  }

  const bookedIds = new Set(booked.map((room) => `${room.nodeId}:${String(room.roomId)}`));
  for (const { nodeId, roomId } of onNodes) {
    if (bookedIds.has(`${nodeId}:${String(roomId)}`)) continue;
    try {
      if (await deps.registry.admin(nodeId).destroyRoom(roomId, secretOf(nodeId, roomId)))
        cleaned += 1;
    } catch {
      // not created by us (wrong secret) or gone meanwhile
    }
  }
  return cleaned;
}
