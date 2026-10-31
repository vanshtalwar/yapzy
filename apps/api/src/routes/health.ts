import { type PrismaClient } from '@app/db';
import { type Redis } from '@app/redis';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

const CHECK_TIMEOUT_MS = 2_000;

async function check(probe: () => Promise<unknown>): Promise<'ok' | 'fail'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('timeout'));
    }, CHECK_TIMEOUT_MS);
  });
  try {
    await Promise.race([probe(), timeout]);
    return 'ok';
  } catch {
    return 'fail';
  } finally {
    clearTimeout(timer);
  }
}

const checkStatus = z.enum(['ok', 'fail']);
const readySchema = z.object({
  status: z.enum(['ready', 'unavailable']),
  checks: z.object({ postgres: checkStatus, redis: checkStatus }),
});

export const healthRoutes: FastifyPluginAsyncZod<{ prisma: PrismaClient; redis: Redis }> = (
  app,
  { prisma, redis },
) => {
  // Liveness: the process is up and the event loop answers. No dependencies.
  app.get(
    '/health',
    { schema: { response: { 200: z.object({ status: z.literal('ok') }) } } },
    () => ({ status: 'ok' as const }),
  );

  // Readiness: only route traffic here when Postgres and Redis answer.
  app.get(
    '/ready',
    { schema: { response: { 200: readySchema, 503: readySchema } } },
    async (_request, reply) => {
      const [postgres, redisStatus] = await Promise.all([
        check(() => prisma.$queryRaw`SELECT 1`),
        check(() => redis.ping()),
      ]);
      const ready = postgres === 'ok' && redisStatus === 'ok';
      return reply.status(ready ? 200 : 503).send({
        status: ready ? 'ready' : 'unavailable',
        checks: { postgres, redis: redisStatus },
      });
    },
  );
  return Promise.resolve();
};
