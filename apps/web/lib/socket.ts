import { type ClientToServerEvents, type ServerToClientEvents } from '@app/shared';
import { io, type Socket } from 'socket.io-client';

import { publicConfig } from './config.ts';
import { getToken } from './session-token.ts';

export type ChatSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: ChatSocket | null = null;

/**
 * One typed Socket.io client per tab. The token is read on every (re)connect, so a refreshed
 * session is picked up automatically. websocket-only, like the gateway.
 */
export function getSocket(): ChatSocket {
  socket ??= io(publicConfig.gatewayUrl, {
    transports: ['websocket'],
    autoConnect: false,
    auth: (callback) => {
      callback({ token: getToken() ?? '' });
    },
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5_000,
    randomizationFactor: 0.5,
    timeout: 10_000,
  });
  return socket;
}
