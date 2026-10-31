import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

import { type PrismaClient } from '@app/db';
import { type GatewayEnv } from '@app/env';
import { type Logger } from '@app/logger';
import { createBanChecker } from '@app/moderation';
import { createRedis, GW_CONTROL_CHANNEL, subscribeControl } from '@app/redis';
import { NOTICE_CODES } from '@app/shared';
import { createVisitorTokenService } from '@app/shared/visitor-token';
import { createShardedAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import { Server } from 'socket.io';

import { createHandshakeMiddleware } from './auth.ts';
import { createClientIpResolver } from './client-ip.ts';
import { registerHandlers } from './handlers/index.ts';
import { startPresence } from './presence.ts';
import { attachGuards, type GuardOptions, markSocketReady } from './register-handler.ts';
import { createSingleSocketPolicy } from './single-socket.ts';
import { type GatewayServer } from './types.ts';

export const GATEWAY_DEFAULTS = {
  maxHttpBufferSize: 32 * 1024,
  pingIntervalMs: 25_000,
  pingTimeoutMs: 20_000,
  presenceIntervalMs: 5_000,
  drainTimeoutMs: 10_000,
  bucket: { capacity: 20, refillPerSecond: 5 },
  abuse: { capacity: 30, refillPerSecond: 0.5 },
} as const;

export interface GatewayOptions {
  /** Override for tests: pub/sub ignores the DB index, so tests must not share real channels. */
  controlChannel?: string;
  adapterChannelPrefix?: string;
  presenceIntervalMs?: number;
  drainTimeoutMs?: number;
  bucket?: GuardOptions['bucket'];
}

export interface GatewayDeps {
  config: GatewayEnv;
  nodeId: string;
  prisma: PrismaClient;
  logger: Logger;
  /** Redis URL for app data (presence, socket keys, ban cache); defaults to REDIS_URL. */
  redisUrl?: string;
  now?: () => Date;
  options?: GatewayOptions;
}

export type ShutdownHook = () => Promise<void>;

/**
 * Builds a gateway node: HTTP server (/health, /ready) + Socket.io with the sharded Redis
 * adapter. The gateway owns its Redis connections and closes them in `shutdown()`; Prisma is
 * owned by the caller.
 */
export async function createGateway(deps: GatewayDeps) {
  const { config, nodeId, prisma, logger, options = {} } = deps;
  const now = deps.now ?? (() => new Date());
  const controlChannel = options.controlChannel ?? GW_CONTROL_CHANNEL;
  let draining = false;
  const shutdownHooks: ShutdownHook[] = [];

  // ioredis: app data + a dedicated subscriber for gw:control.
  const redis = createRedis(deps.redisUrl ?? config.REDIS_URL, {
    connectionName: `gateway:${nodeId}`,
    logger,
  });
  const controlSubscriber = createRedis(config.REDIS_URL, {
    connectionName: `gateway:${nodeId}:control`,
    logger,
  });

  // node-redis: only for the sharded adapter, which requires it (CONTEXT.md D-031).
  const adapterPub = createClient({ url: config.REDIS_URL });
  const adapterSub = adapterPub.duplicate();
  for (const client of [adapterPub, adapterSub]) {
    client.on('error', (error: unknown) => {
      logger.error({ err: error }, 'adapter redis error');
    });
  }
  await Promise.all([adapterPub.connect(), adapterSub.connect()]);

  async function readiness(): Promise<boolean> {
    if (draining) return false;
    try {
      await Promise.all([redis.ping(), adapterPub.ping(), prisma.$queryRaw`SELECT 1`]);
      return true;
    } catch {
      return false;
    }
  }

  // Socket.io handles /socket.io/*; everything else lands here.
  const httpServer = createServer((request: IncomingMessage, response: ServerResponse) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    };
    if (request.method === 'GET' && request.url === '/health') {
      send(200, { status: 'ok' });
    } else if (request.method === 'GET' && request.url === '/ready') {
      void readiness().then((ready) => {
        send(ready ? 200 : 503, { status: ready ? 'ready' : 'unavailable' });
      });
    } else {
      send(404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    }
  });

  const allowedOrigins = new Set(config.CORS_ORIGINS);
  const io: GatewayServer = new Server(httpServer, {
    transports: ['websocket'],
    perMessageDeflate: false,
    maxHttpBufferSize: GATEWAY_DEFAULTS.maxHttpBufferSize,
    pingInterval: GATEWAY_DEFAULTS.pingIntervalMs,
    pingTimeout: GATEWAY_DEFAULTS.pingTimeoutMs,
    serveClient: false,
    cors: { origin: config.CORS_ORIGINS, methods: ['GET', 'POST'] },
    // Explicit Origin check: browsers always send Origin on WebSocket upgrades, and CORS does
    // not protect WebSockets. Non-browser clients (bots, tests) send none and still need a JWT.
    allowRequest: (request, callback) => {
      const origin = request.headers.origin;
      callback(null, !draining && (origin === undefined || allowedOrigins.has(origin)));
    },
    adapter: createShardedAdapter(adapterPub, adapterSub, {
      subscriptionMode: 'dynamic',
      ...(options.adapterChannelPrefix === undefined
        ? {}
        : { channelPrefix: options.adapterChannelPrefix }),
    }),
  });

  const rateLimitEnabled = !(config.RATE_LIMIT_DISABLED && config.NODE_ENV === 'development');
  if (!rateLimitEnabled) logger.warn('socket rate limiting DISABLED (development)');

  const tokens = createVisitorTokenService({
    secret: config.JWT_SECRET,
    // Verification never uses the TTL; the API decides token lifetime.
    ttlSeconds: 60,
    now,
  });
  const bans = createBanChecker({ prisma, redis, logger, now });

  io.use(
    createHandshakeMiddleware({
      tokens,
      bans,
      ipPepper: config.IP_HASH_PEPPER,
      clientIp: createClientIpResolver(config.TRUST_PROXY),
      isDraining: () => draining,
      logger,
    }),
  );

  const singleSocket = createSingleSocketPolicy({ io, redis, nodeId, controlChannel, logger });
  const unsubscribeControl = await subscribeControl(
    controlSubscriber,
    {
      onMessage: (message) => {
        singleSocket.onControlMessage(message).catch((error: unknown) => {
          logger.warn({ err: error, type: message.type }, 'control message handling failed');
        });
      },
      onInvalid: (error) => {
        logger.warn({ err: error }, 'invalid gw:control message dropped');
      },
    },
    controlChannel,
  );

  const presence = startPresence({
    redis,
    nodeId,
    intervalMs: options.presenceIntervalMs ?? GATEWAY_DEFAULTS.presenceIntervalMs,
    countSockets: () => io.of('/').sockets.size,
    logger,
  });

  io.on('connection', (socket) => {
    const { visitorId } = socket.data;
    // Listeners first (synchronously) so no early event is lost while we await Redis below.
    attachGuards(socket, {
      rateLimitEnabled,
      bucket: options.bucket ?? GATEWAY_DEFAULTS.bucket,
      abuse: GATEWAY_DEFAULTS.abuse,
      logger,
    });
    registerHandlers(socket, now);

    socket.on('disconnect', (reason) => {
      logger.debug({ visitorId, socketId: socket.id, reason }, 'socket disconnected');
      singleSocket.release(socket).catch((error: unknown) => {
        logger.warn({ err: error, visitorId }, 'failed to release socket key');
      });
    });

    const claimed = singleSocket.claim(socket).then(
      () => {
        logger.debug({ visitorId, socketId: socket.id, pool: socket.data.pool }, 'connected');
      },
      (error: unknown) => {
        logger.error({ err: error, visitorId }, 'failed to register socket; disconnecting');
        socket.disconnect(true);
        throw error;
      },
    );
    // Handlers that await `claimed` see the rejection; this only prevents an unhandled one.
    claimed.catch(() => undefined);
    markSocketReady(socket, claimed);
  });

  let shutdownPromise: Promise<void> | null = null;

  async function doShutdown(): Promise<void> {
    draining = true; // new handshakes are refused and /ready reports 503 from here on
    logger.info({ nodeId }, 'gateway draining');

    for (const hook of shutdownHooks) {
      try {
        await hook();
      } catch (error) {
        logger.error({ err: error }, 'shutdown hook failed');
      }
    }

    io.local.emit('system:notice', {
      code: NOTICE_CODES.SERVER_RESTARTING,
      message: 'Server restarting; reconnecting you',
    });

    // Give clients time to reconnect elsewhere; stop early once everyone has left.
    const deadline = Date.now() + (options.drainTimeoutMs ?? GATEWAY_DEFAULTS.drainTimeoutMs);
    while (io.of('/').sockets.size > 0 && Date.now() < deadline) await sleep(100);

    io.local.disconnectSockets(true);
    await unsubscribeControl().catch(() => undefined);
    await presence.stop().catch((error: unknown) => {
      logger.warn({ err: error }, 'presence cleanup failed');
    });
    await io.close(); // closes the HTTP server and the adapter
    await Promise.allSettled([
      redis.quit(),
      controlSubscriber.quit(),
      adapterPub.close(),
      adapterSub.close(),
    ]);
    logger.info({ nodeId }, 'gateway stopped');
  }

  return {
    io,
    httpServer,
    nodeId,
    presence,
    listen(port: number, host?: string): Promise<number> {
      return new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, host, () => {
          const address = httpServer.address();
          resolve(typeof address === 'object' && address !== null ? address.port : port);
        });
      });
    },
    /** Part 5 registers session clean-up here; hooks run before sockets are notified. */
    onShutdown(hook: ShutdownHook): void {
      shutdownHooks.push(hook);
    },
    shutdown(): Promise<void> {
      shutdownPromise ??= doShutdown();
      return shutdownPromise;
    },
  };
}

export type Gateway = Awaited<ReturnType<typeof createGateway>>;
