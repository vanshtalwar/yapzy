import { prisma } from '@app/db';
import { createEnv, workerEnv } from '@app/env';
import { createLogger } from '@app/logger';

import { createWorkers } from './worker.ts';

const FORCE_EXIT_AFTER_MS = 30_000;

const config = createEnv(workerEnv, { service: 'worker' });
const logger = createLogger({
  service: 'worker',
  level: config.LOG_LEVEL,
  nodeEnv: config.NODE_ENV,
});

const workers = createWorkers({
  redisUrl: config.REDIS_URL,
  prisma,
  logger,
  concurrency: config.WORKER_CONCURRENCY,
});
logger.info({ concurrency: config.WORKER_CONCURRENCY }, 'worker started');

let stopping = false;
async function stop(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'shutting down (finishing in-flight jobs)');
  setTimeout(() => {
    logger.error('shutdown timed out; forcing exit');
    process.exit(1);
  }, FORCE_EXIT_AFTER_MS).unref();
  try {
    await workers.close();
    await prisma.$disconnect();
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'error during shutdown');
    process.exit(1);
  }
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, (received) => {
    void stop(received);
  });
}
