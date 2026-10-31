import { prisma } from '@app/db';
import { apiEnv, createEnv } from '@app/env';
import { createLogger } from '@app/logger';
import { createRedis } from '@app/redis';

import { buildApp } from './app.ts';
import { createCloudflareTurnstileVerifier } from './services/turnstile.ts';

const SHUTDOWN_TIMEOUT_MS = 10_000;

const config = createEnv(apiEnv, { service: 'api' });
const logger = createLogger({ service: 'api', level: config.LOG_LEVEL, nodeEnv: config.NODE_ENV });
const redis = createRedis(config.REDIS_URL, { connectionName: 'api', logger });

const app = await buildApp({
  config,
  prisma,
  redis,
  turnstile: createCloudflareTurnstileVerifier({ secretKey: config.TURNSTILE_SECRET_KEY }),
  logger,
});

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  setTimeout(() => {
    logger.error('graceful shutdown timed out; forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  try {
    await app.close(); // stops accepting connections, waits for in-flight requests
    await Promise.allSettled([prisma.$disconnect(), redis.quit()]);
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'error during shutdown');
    process.exit(1);
  }
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, (received) => {
    void shutdown(received);
  });
}

try {
  await app.listen({ host: config.API_HOST, port: config.API_PORT });
} catch (error) {
  logger.fatal({ err: error }, 'failed to start');
  process.exit(1);
}
