import { createHmac, randomInt } from 'node:crypto';

import { z } from 'zod';

import { type JanusAdminClient, JanusAdminError } from './admin-client.ts';
import { VIDEOROOM_PLUGIN } from './tokens.ts';

/** VideoRoom error codes we react to (janus_videoroom.c). */
export const VIDEOROOM_ERRORS = {
  NO_SUCH_ROOM: 426,
  ROOM_EXISTS: 427,
  NO_SUCH_FEED: 428,
  UNAUTHORIZED: 433,
} as const;

/** Most people in one call (Part 12); also the room's publisher limit. */
export const ROOM_PUBLISHERS = 4;

/**
 * Random numeric room id. Janus ids are 64-bit; we stay below 2^53 so they survive JSON in
 * every browser.
 */
export function newRoomId(): number {
  return randomInt(1, 2 ** 48);
}

/**
 * Room `secret` (needed to destroy a room, edit its allowed list or kick someone), derived
 * from the admin secret: every gateway node can manage every room without storing secrets,
 * and orphaned rooms found on a node can still be destroyed.
 */
export function roomSecret(adminSecret: string, nodeId: string, roomId: number): string {
  return createHmac('sha256', adminSecret)
    .update(`room:${nodeId}:${String(roomId)}`)
    .digest('base64url');
}

export interface CreateRoomInput {
  roomId: number;
  secret: string;
  /** Tokens allowed to join (one per participant); enables the room's token check. */
  allowed: string[];
  /** Max video bitrate per publisher (bps). */
  bitrate: number;
  publishers?: number;
}

const pluginError = z.object({
  videoroom: z.literal('event'),
  error_code: z.number(),
  error: z.string(),
});
const roomsList = z.object({
  videoroom: z.literal('success'),
  list: z.array(z.object({ room: z.number() })),
});
const participantsList = z.object({
  videoroom: z.literal('participants'),
  participants: z.array(
    z.object({ id: z.number(), display: z.string().optional(), publisher: z.boolean() }),
  ),
});

/** VideoRoom requests through the Admin API (`message_plugin`), with plugin errors thrown. */
export function createVideoRoomAdmin(client: JanusAdminClient, adminKey: string) {
  async function call(body: Record<string, unknown>): Promise<unknown> {
    const response = await client.messagePlugin(VIDEOROOM_PLUGIN, body);
    const failed = pluginError.safeParse(response);
    if (failed.success) throw new JanusAdminError(failed.data.error_code, failed.data.error);
    return response;
  }

  return {
    client,

    /**
     * A private room for one call: only our tokens may join (`allowed`), subscribers must
     * belong to a publisher in the room (`require_pvtid`), VP8 + Opus with simulcast, talking
     * events for the active-speaker highlight, never recorded.
     */
    async createRoom(input: CreateRoomInput): Promise<void> {
      await call({
        request: 'create',
        admin_key: adminKey,
        room: input.roomId,
        permanent: false,
        description: 'randomchat',
        is_private: true,
        secret: input.secret,
        allowed: input.allowed,
        require_pvtid: true,
        publishers: input.publishers ?? ROOM_PUBLISHERS,
        bitrate: input.bitrate,
        bitrate_cap: true,
        audiocodec: 'opus',
        videocodec: 'vp8',
        notify_joining: true,
        audiolevel_ext: true,
        audiolevel_event: true,
        record: false,
        lock_record: true,
      });
    },

    /** Returns false if the room did not exist (already destroyed or the node restarted). */
    async destroyRoom(roomId: number, secret: string): Promise<boolean> {
      try {
        await call({ request: 'destroy', room: roomId, secret, permanent: false });
        return true;
      } catch (error) {
        if (error instanceof JanusAdminError && error.code === VIDEOROOM_ERRORS.NO_SUCH_ROOM) {
          return false;
        }
        throw error;
      }
    },

    async allowTokens(
      roomId: number,
      secret: string,
      action: 'add' | 'remove',
      tokens: string[],
    ): Promise<void> {
      if (tokens.length === 0) return;
      await call({ request: 'allowed', room: roomId, secret, action, allowed: tokens });
    },

    async listParticipants(roomId: number) {
      return participantsList.parse(await call({ request: 'listparticipants', room: roomId }))
        .participants;
    },

    /** Kicks one participant (publisher id); a participant that is already gone is fine. */
    async kick(roomId: number, secret: string, participantId: number): Promise<void> {
      try {
        await call({ request: 'kick', room: roomId, secret, id: participantId });
      } catch (error) {
        if (error instanceof JanusAdminError && error.code === VIDEOROOM_ERRORS.NO_SUCH_FEED) {
          return;
        }
        throw error;
      }
    },

    /** Ids of every room on the node, private ones included (needs the admin key). */
    async listRooms(): Promise<number[]> {
      const response = roomsList.parse(await call({ request: 'list', admin_key: adminKey }));
      return response.list.map((room) => room.room);
    },
  };
}

export type VideoRoomAdmin = ReturnType<typeof createVideoRoomAdmin>;
