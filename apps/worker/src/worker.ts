import { type PrismaClient } from '@app/db';
import { type Logger } from '@app/logger';
import {
  BULLMQ_PREFIX,
  QUEUE_NAMES,
  type SessionLogJob,
  sessionLogJobSchema,
} from '@app/shared/jobs';
import { Worker } from 'bullmq';

import { persistSessionLog } from './jobs/session-log.ts';

export interface WorkerDeps {
  redisUrl: string;
  prisma: PrismaClient;
  logger: Logger;
  concurrency: number;
}

/** BullMQ consumers. Job payloads are re-validated here: the queue is a trust boundary too. */
export function createWorkers(deps: WorkerDeps) {
  const { prisma, logger } = deps;

  const sessionLog = new Worker<SessionLogJob>(
    QUEUE_NAMES.SESSION_LOG,
    async (job) => {
      const data = sessionLogJobSchema.parse(job.data);
      const result = await persistSessionLog(prisma, data, logger);
      logger.debug({ sessionId: data.sessionId, ...result }, 'session log persisted');
      return result;
    },
    {
      // Workers block on Redis; BullMQ requires unlimited retries per request for them.
      connection: { url: deps.redisUrl, maxRetriesPerRequest: null },
      prefix: BULLMQ_PREFIX,
      concurrency: deps.concurrency,
    },
  );

  sessionLog.on('failed', (job, error) => {
    logger.error(
      { err: error, jobId: job?.id, attempts: job?.attemptsMade },
      'session-log job failed',
    );
  });
  sessionLog.on('error', (error) => {
    logger.error({ err: error }, 'session-log worker error');
  });

  return {
    sessionLog,
    /** Waits for in-flight jobs to finish, then disconnects. */
    async close(): Promise<void> {
      await sessionLog.close();
    },
  };
}
