import {
  MAX_INTERESTS,
  MAX_MESSAGE_LENGTH,
  publicConfigSchema,
  SUPPORTED_LANGS,
} from '@app/shared';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

/** Public client configuration. Feature flags flip as later parts land. */
export const configRoutes: FastifyPluginAsyncZod<{ tosVersion: string }> = (
  app,
  { tosVersion },
) => {
  app.get(
    '/v1/config',
    { schema: { response: { 200: publicConfigSchema } } },
    (_request, reply) => {
      void reply.header('cache-control', 'public, max-age=60');
      return {
        tosVersion,
        maxMessageLength: MAX_MESSAGE_LENGTH,
        maxInterests: MAX_INTERESTS,
        supportedLangs: [...SUPPORTED_LANGS],
        features: { video: true, reports: false },
      };
    },
  );
  return Promise.resolve();
};
