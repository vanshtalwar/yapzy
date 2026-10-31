import { type IncomingMessage } from 'node:http';

import { type Logger } from '@app/logger';
import { type BanChecker } from '@app/moderation';
import { ErrorCode } from '@app/shared';
import { hmacHash } from '@app/shared/crypto';
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
  logger: Pick<Logger, 'info' | 'warn'>;
}

/**
 * Socket.io middleware: authenticates the visitor JWT from `auth.token`, applies bans and fills
 * `socket.data`. Rejections reach the client as `connect_error` with `data: { code, message }`.
 */
export function createHandshakeMiddleware(deps: HandshakeDeps) {
  const { tokens, bans, ipPepper, clientIp, isDraining, logger } = deps;

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

    const ipHash = hmacHash(clientIp(socket.request), ipPepper);
    const ban = await bans.findActiveBan({ visitorId, ipHash });
    if (ban?.type === 'HARD') {
      logger.info({ visitorId, banId: ban.banId }, 'banned visitor refused at handshake');
      throw new HandshakeError(ErrorCode.BANNED, 'Access denied', { expiresAt: ban.expiresAt });
    }

    socket.data = {
      visitorId,
      ipHash,
      pool: ban?.type === 'SHADOW' ? 'shadow' : 'normal',
      state: 'idle',
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
