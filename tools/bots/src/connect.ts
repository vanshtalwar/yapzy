/**
 * `pnpm --filter @app/bots connect [--count N] [--gateway URL[,URL...]] [--api URL]`
 *
 * Opens N anonymous visitor connections (round-robin over the gateways) and keeps them open
 * until Ctrl-C, logging connection events. Use it to watch `/v1/stats/online` change.
 */
import { parseArgs } from 'node:util';

import { createEnv } from '@app/env';
import { createLogger } from '@app/logger';
import { type ClientToServerEvents, type ServerToClientEvents } from '@app/shared';
import { io, type Socket } from 'socket.io-client';
import { z } from 'zod';

import { startSession } from './session.ts';

const env = createEnv(
  z.object({
    NEXT_PUBLIC_API_URL: z.url().default('http://localhost:4000'),
    NEXT_PUBLIC_GATEWAY_URL: z.url().default('http://localhost:4001'),
  }),
  { service: 'bots' },
);

const { values } = parseArgs({
  options: {
    count: { type: 'string', default: '1' },
    gateway: { type: 'string', default: env.NEXT_PUBLIC_GATEWAY_URL },
    api: { type: 'string', default: env.NEXT_PUBLIC_API_URL },
  },
});

const args = z
  .object({
    count: z.coerce.number().int().min(1).max(500),
    gateway: z.string().transform((value) => value.split(',').map((url) => url.trim())),
    api: z.url(),
  })
  .parse(values);

const log = createLogger({ service: 'bots', level: 'info', nodeEnv: 'development' });
const sockets: Socket<ServerToClientEvents, ClientToServerEvents>[] = [];

for (let index = 0; index < args.count; index += 1) {
  const gateway = args.gateway[index % args.gateway.length] ?? env.NEXT_PUBLIC_GATEWAY_URL;
  const { token, visitorId } = await startSession(args.api);
  const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(gateway, {
    transports: ['websocket'],
    auth: { token },
  });
  const bot = { bot: index + 1, visitorId, gateway };

  socket.on('connect', () => {
    log.info(bot, 'connected');
  });
  socket.on('connect_error', (error: Error & { data?: unknown }) => {
    log.warn({ ...bot, error: error.message, data: error.data }, 'connect error');
  });
  socket.on('disconnect', (reason) => {
    log.info({ ...bot, reason }, 'disconnected');
  });
  socket.on('system:notice', (notice) => {
    log.info({ ...bot, notice }, 'system notice');
  });
  sockets.push(socket);
}

log.info({ count: sockets.length }, 'bots running; Ctrl-C to stop');

process.once('SIGINT', () => {
  for (const socket of sockets) socket.disconnect();
  process.exit(0);
});
