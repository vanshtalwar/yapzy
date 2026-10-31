import { type Logger } from '@app/logger';
import {
  type GwControlMessage,
  publishControl,
  type Redis,
  visitorRoom,
  visitorSocketKey,
} from '@app/redis';
import { NOTICE_CODES } from '@app/shared';

import { type GatewayServer, type GatewaySocket } from './types.ts';

/** Safety net: the key is deleted on disconnect; this only bounds leaks from crashed nodes. */
const SOCKET_KEY_TTL_SECONDS = 24 * 60 * 60;

/** Deletes the key only if it still names this socket (a newer connection may own it). */
const DELETE_IF_OWNER = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export interface SingleSocketDeps {
  io: GatewayServer;
  redis: Redis;
  nodeId: string;
  controlChannel: string;
  logger: Pick<Logger, 'info' | 'warn'>;
}

/**
 * One live socket per visitor, across all nodes. The newest connection records itself in
 * `visitor:<id>:socket`, then broadcasts `kick_visitor`; every node disconnects its local sockets
 * of that visitor that are not the recorded one. Deciding by the Redis key (not by message
 * order) means the LAST connection wins even when two connections race on different nodes.
 */
export function createSingleSocketPolicy(deps: SingleSocketDeps) {
  const { io, redis, nodeId, controlChannel, logger } = deps;

  async function evictStale(visitorId: string): Promise<void> {
    const current = await redis.get(visitorSocketKey(visitorId));
    const sockets = await io.local.in(visitorRoom(visitorId)).fetchSockets();
    for (const socket of sockets) {
      if (socket.id === current) continue;
      logger.info({ visitorId, socketId: socket.id }, 'socket replaced by a newer connection');
      socket.emit('system:notice', {
        code: NOTICE_CODES.SESSION_REPLACED,
        message: 'You connected from another tab or device',
      });
      socket.disconnect(true);
    }
  }

  return {
    /** Claims the visitor for this socket; call on every new connection. */
    async claim(socket: GatewaySocket): Promise<void> {
      const { visitorId } = socket.data;
      await redis.set(visitorSocketKey(visitorId), socket.id, 'EX', SOCKET_KEY_TTL_SECONDS);
      await publishControl(
        redis,
        {
          type: 'kick_visitor',
          originNodeId: nodeId,
          visitorId,
          reason: 'session_replaced',
          keepSocketId: socket.id,
        },
        controlChannel,
      );
      await socket.join(visitorRoom(visitorId));
      // A newer connection may have claimed the key while we were joining.
      await evictStale(visitorId);
    },

    async release(socket: GatewaySocket): Promise<void> {
      await redis.eval(DELETE_IF_OWNER, 1, visitorSocketKey(socket.data.visitorId), socket.id);
    },

    async onControlMessage(message: GwControlMessage): Promise<void> {
      if (message.type === 'kick_visitor') await evictStale(message.visitorId);
    },
  };
}
