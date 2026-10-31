import { MAX_INTERESTS, MAX_MESSAGE_LENGTH, SUPPORTED_LANGS } from '@app/shared';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

const configResponse = z.object({
  tosVersion: z.string(),
  maxMessageLength: z.number().int(),
  maxInterests: z.number().int(),
  supportedLangs: z.array(z.string()),
  features: z.object({ video: z.boolean(), reports: z.boolean() }),
});

/** Public client configuration. Feature flags flip as later parts land. */
export const configRoutes: FastifyPluginAsyncZod<{ tosVersion: string }> = (
  app,
  { tosVersion },
) => {
  app.get('/v1/config', { schema: { response: { 200: configResponse } } }, (_request, reply) => {
    void reply.header('cache-control', 'public, max-age=60');
    return {
      tosVersion,
      maxMessageLength: MAX_MESSAGE_LENGTH,
      maxInterests: MAX_INTERESTS,
      supportedLangs: [...SUPPORTED_LANGS],
      features: { video: true, reports: false },
    };
  });
  return Promise.resolve();
};
