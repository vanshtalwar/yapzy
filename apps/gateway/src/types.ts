import { type ClientToServerEvents, type ServerToClientEvents, type SocketData } from '@app/shared';
import { type Server, type Socket } from 'socket.io';

/** No server-to-server events: cross-node control goes through `gw:control` instead. */
export type InterServerEvents = Record<string, never>;

export type GatewayServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

export type GatewaySocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;
