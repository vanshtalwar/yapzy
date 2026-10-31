import { ErrorCode } from '@app/shared';
import { VisitorTokenError, type VisitorTokenService } from '@app/shared/visitor-token';
import { type FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

import { AppError } from '../errors.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `app.authenticate`; null on routes that don't require a visitor. */
    visitor: { id: string } | null;
  }
  interface FastifyInstance {
    authenticate: (request: FastifyRequest) => Promise<void>;
  }
}

const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;

/** Bearer-JWT auth. Use as `onRequest: [app.authenticate]` on routes that need a visitor. */
export const authPlugin = fp<{ tokens: VisitorTokenService }>(
  (app, { tokens }, done) => {
    app.decorateRequest('visitor', null);

    app.decorate('authenticate', async (request: FastifyRequest) => {
      const header = request.headers.authorization;
      if (header === undefined || header === '') {
        throw new AppError(401, ErrorCode.UNAUTHORIZED, 'Missing bearer token');
      }
      const token = BEARER.exec(header)?.[1];
      if (token === undefined) {
        throw new AppError(401, ErrorCode.TOKEN_INVALID, 'Malformed authorization header');
      }
      try {
        const claims = await tokens.verify(token);
        request.visitor = { id: claims.visitorId };
      } catch (error) {
        if (error instanceof VisitorTokenError && error.kind === 'expired') {
          throw new AppError(401, ErrorCode.TOKEN_EXPIRED, 'Session expired; start a new session');
        }
        throw new AppError(401, ErrorCode.TOKEN_INVALID, 'Invalid session token');
      }
    });

    done();
  },
  { name: 'auth' },
);
