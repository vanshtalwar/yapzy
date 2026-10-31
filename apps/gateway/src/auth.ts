import { type IncomingMessage } from 'node:http';

import { type Logger } from '@app/logger';
import { type BanChecker } from '@app/moderation';
import { rateLimitKey, type Redis } from '@app/redis';
import { ErrorCode, type MatchPool } from '@app/shared';
import { hashIp } from '@app/shared/crypto';
import { VisitorTokenError, type VisitorTokenService } from '@app/shared/visitor-token';
import { z } from 'zod';

import { HandshakeError } from './errors.ts';
import { type GatewaySocket } from './types.ts';

const handshakeAuthSchema = z.object({ token: z.string().min(1).max(4096) });

export interface HandshakeDeps {
  tokens: VisitorTokenService;
  bans: BanChecker;
  ipPepper: string;
  clientIp: (request: IncomingMessage) => string;
  isDraining: () => boolean;
  /** Pool from the ban type and the cached trust score (shadow below the trust threshold). */
  poolFor: (visitorId: string, banType: 'HARD' | 'SHADOW' | null) => Promise<MatchPool>;
  /** Handshakes per minute per visitor / per IP hash; null = off (RATE_LIMIT_DISABLED, dev). */
  limits: { perVisitor: number; perIp: number } | null;
  redis: Redis;
  now: () => Date;
  onLimited: () => void;
  logger: Pick<Logger, 'info' | 'warn'>;
}

/** Fixed-window counter (INCR, expiry on the first hit); one key per command (cluster-safe). */
async function hit(redis: Redis, key: string): Promise<number> {
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 61);
  return count;
}

/**
 * Socket.io middleware: authenticates the visitor JWT from `auth.token`, applies bans and fills
 * `socket.data`. Rejections reach the client as `connect_error` with `data: { code, message }`.
 */
export function createHandshakeMiddleware(deps: HandshakeDeps) {
  const { tokens, bans, ipPepper, clientIp, isDraining, poolFor, limits, redis, logger } = deps;

  /**
   * Every handshake costs a ban lookup, a Redis claim and a `kick_visitor` broadcast to all
   * nodes, and a fresh socket starts with a full event bucket, so connect loops are limited.
   * Fails open: a Redis hiccup must not lock everyone out (the API limits sessions too).
   */
  async function overLimit(visitorId: string, ipHash: string): Promise<boolean> {
    if (limits === null) return false;
    const window = String(Math.floor(deps.now().getTime() / 60_000));
    try {
      const [byVisitor, byIp] = await Promise.all([
        hit(redis, rateLimitKey(`handshake:visitor:${window}`, visitorId)),
        hit(redis, rateLimitKey(`handshake:ip:${window}`, ipHash)),
      ]);
      return byVisitor > limits.perVisitor || byIp > limits.perIp;
    } catch (error) {
      logger.warn({ err: error }, 'handshake rate limit unavailable; allowing');
      return false;
    }
  }

  async function authenticate(socket: GatewaySocket): Promise<void> {
    if (isDraining()) {
      throw new HandshakeError(ErrorCode.SERVER_RESTARTING, 'Server restarting; reconnect');
    }

    const auth = handshakeAuthSchema.safeParse(socket.handshake.auth);
    if (!auth.success) throw new HandshakeError(ErrorCode.UNAUTHORIZED, 'Missing session token');

    let visitorId: string;
    try {
      visitorId = (await tokens.verify(auth.data.token)).visitorId;
    } catch (error) {
      if (error instanceof VisitorTokenError && error.kind === 'expired') {
        throw new HandshakeError(ErrorCode.TOKEN_EXPIRED, 'Session expired; start a new session');
      }
      throw new HandshakeError(ErrorCode.TOKEN_INVALID, 'Invalid session token');
    }

    const ipHash = hashIp(clientIp(socket.request), ipPepper);
    if (await overLimit(visitorId, ipHash)) {
      deps.onLimited();
      throw new HandshakeError(ErrorCode.RATE_LIMITED, 'Too many connections; retry shortly');
    }
    const ban = await bans.findActiveBan({ visitorId, ipHash });
    if (ban?.type === 'HARD') {
      logger.info({ visitorId, banId: ban.banId }, 'banned visitor refused at handshake');
      throw new HandshakeError(ErrorCode.BANNED, 'Access denied', { expiresAt: ban.expiresAt });
    }

    socket.data = {
      visitorId,
      ipHash,
      pool: await poolFor(visitorId, ban?.type ?? null),
      state: 'idle',
      preferences: null,
    };
  }

  return (socket: GatewaySocket, next: (error?: Error) => void): void => {
    authenticate(socket).then(
      () => {
        next();
      },
      (error: unknown) => {
        if (error instanceof HandshakeError) {
          next(error);
          return;
        }
        logger.warn({ err: error }, 'handshake failed unexpectedly');
        next(new HandshakeError(ErrorCode.SERVICE_UNAVAILABLE, 'Try again shortly'));
      },
    );
  };
}
