import { prisma } from '@app/db';
import { createEnv, workerEnv } from '@app/env';
import { createLogger } from '@app/logger';
import {
  createBanService,
  createRiskProfiles,
  createTrustStore,
  MockImageClassifier,
  NoopHashMatcher,
} from '@app/moderation';
import { createRedis } from '@app/redis';
import { createObjectStore } from '@app/storage';

import { startWorkerHttp } from './http.ts';
import { createDefaultWorkerMetrics } from './metrics.ts';
import { createWorkers } from './worker.ts';

const FORCE_EXIT_AFTER_MS = 30_000;

const config = createEnv(workerEnv, { service: 'worker' });
const logger = createLogger({
  service: 'worker',
  level: config.LOG_LEVEL,
  nodeEnv: config.NODE_ENV,
});

const redis = createRedis(config.REDIS_URL, { connectionName: 'worker', logger });
const objects = createObjectStore({
  endpoint: config.S3_ENDPOINT,
  region: config.S3_REGION,
  accessKeyId: config.S3_ACCESS_KEY,
  secretAccessKey: config.S3_SECRET_KEY,
});

// Development: frames of DEV_FORCE_FLAG_VISITOR_IDS are always flagged (ignored elsewhere).
const forceFlag = config.NODE_ENV === 'development' ? config.DEV_FORCE_FLAG_VISITOR_IDS : [];
if (config.DEV_FORCE_FLAG_VISITOR_IDS.length > 0 && config.NODE_ENV !== 'development') {
  logger.warn('DEV_FORCE_FLAG_VISITOR_IDS ignored outside NODE_ENV=development');
}
if (config.NODE_ENV === 'production') {
  logger.warn('using the mock image classifier and no-op hash matcher (see PRODUCTION_CHECKLIST)');
}

const metrics = createDefaultWorkerMetrics(true);
const workers = createWorkers({
  metrics,
  redisUrl: config.REDIS_URL,
  prisma,
  logger,
  concurrency: config.WORKER_CONCURRENCY,
  frameBudgetPerSec: config.MOD_FRAME_BUDGET_PER_SEC,
  moderation: {
    prisma,
    redis,
    objects,
    buckets: { evidence: config.S3_BUCKET_EVIDENCE, frames: config.S3_BUCKET_FRAMES },
    classifier: new MockImageClassifier(forceFlag),
    hashMatcher: new NoopHashMatcher(),
    bans: createBanService({ prisma, redis, logger, originNodeId: 'worker' }),
    trust: createTrustStore({ prisma, redis }),
    risk: createRiskProfiles({ redis }),
    config: {
      flagThreshold: 0.8,
      autoShadowScore: config.MOD_AUTO_SHADOW_SCORE,
      reportThreshold: config.MOD_REPORT_THRESHOLD,
      autoBanHours: config.MOD_AUTO_BAN_HOURS,
    },
    logger,
  },
});
const metricsAccess = {
  token: config.METRICS_TOKEN,
  requireToken: config.DEPLOY_ENV === 'production',
};
if (metricsAccess.requireToken && config.METRICS_TOKEN === undefined) {
  logger.warn('METRICS_TOKEN not set: /metrics is disabled (DEPLOY_ENV=production)');
}
const http = await startWorkerHttp({
  host: config.WORKER_METRICS_HOST,
  port: config.WORKER_METRICS_PORT,
  registry: metrics.registry,
  access: metricsAccess,
});
logger.info(
  { concurrency: config.WORKER_CONCURRENCY, port: http.port },
  'worker started (/health, /metrics)',
);

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
    await http.close();
    await workers.close();
    await Promise.allSettled([prisma.$disconnect(), redis.quit()]);
    objects.destroy();
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
