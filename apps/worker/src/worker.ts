import { type PrismaClient } from '@app/db';
import { type Logger } from '@app/logger';
import {
  BULLMQ_PREFIX,
  type ClassifyFrameJob,
  classifyFrameJobSchema,
  type ModerationEventJob,
  moderationEventJobSchema,
  QUEUE_NAMES,
  type ReportFiledJob,
  reportFiledJobSchema,
  type SessionLogJob,
  sessionLogJobSchema,
} from '@app/shared/jobs';
import { type Job, Queue, Worker } from 'bullmq';

import { persistSessionLog } from './jobs/session-log.ts';
import { updateBudgetMultiplier } from './moderation/budget.ts';
import { classifyFrame } from './moderation/classify-frame.ts';
import { type ModerationDeps } from './moderation/deps.ts';
import { recordModerationEvent } from './moderation/moderation-event.ts';
import { handleReportFiled } from './moderation/report-filed.ts';
import { applySessionTrust } from './moderation/session-trust.ts';

export interface WorkerDeps {
  redisUrl: string;
  prisma: PrismaClient;
  logger: Logger;
  concurrency: number;
  moderation: ModerationDeps;
  /** Global cap on moderation frames per second (D-054). */
  frameBudgetPerSec: number;
  /** How often the budget multiplier is recomputed; 0 disables it (tests). */
  budgetIntervalMs?: number;
}

/** BullMQ consumers. Job payloads are re-validated here: the queue is a trust boundary too. */
export function createWorkers(deps: WorkerDeps) {
  const { prisma, logger, moderation } = deps;
  const options = (concurrency: number) => ({
    // Workers block on Redis; BullMQ requires unlimited retries per request for them.
    connection: { url: deps.redisUrl, maxRetriesPerRequest: null },
    prefix: BULLMQ_PREFIX,
    concurrency,
  });

  const workers: Worker[] = [];
  function consume<T>(name: string, concurrency: number, run: (job: Job<T>) => Promise<unknown>) {
    const worker = new Worker<T>(name, run, options(concurrency));
    worker.on('failed', (job, error) => {
      logger.error(
        { err: error, queue: name, jobId: job?.id, attempts: job?.attemptsMade },
        'job failed',
      );
    });
    worker.on('error', (error) => {
      logger.error({ err: error, queue: name }, 'worker error');
    });
    workers.push(worker as Worker);
    return worker;
  }

  const sessionLog = consume<SessionLogJob>(
    QUEUE_NAMES.SESSION_LOG,
    deps.concurrency,
    async (job) => {
      const data = sessionLogJobSchema.parse(job.data);
      const { known, ...result } = await persistSessionLog(prisma, data, logger);
      const trust = await applySessionTrust(moderation, data, known);
      logger.debug({ sessionId: data.sessionId, ...result, ...trust }, 'session log persisted');
      return { ...result, ...trust };
    },
  );

  const frames = consume<ClassifyFrameJob>(QUEUE_NAMES.CLASSIFY_FRAME, deps.concurrency, (job) =>
    classifyFrame(moderation, classifyFrameJobSchema.parse(job.data)),
  );

  const events = consume<ModerationEventJob>(
    QUEUE_NAMES.MODERATION_EVENT,
    deps.concurrency,
    (job) => recordModerationEvent(moderation, moderationEventJobSchema.parse(job.data)),
  );

  // One at a time: the threshold check reads reports another job may be adding.
  const reports = consume<ReportFiledJob>(QUEUE_NAMES.REPORT_FILED, 1, (job) =>
    handleReportFiled(moderation, reportFiledJobSchema.parse(job.data)),
  );

  // Frame budget: the classify-frame backlog is part of the signal.
  const frameQueue = new Queue(QUEUE_NAMES.CLASSIFY_FRAME, {
    connection: { url: deps.redisUrl },
    prefix: BULLMQ_PREFIX,
  });
  const budgetIntervalMs = deps.budgetIntervalMs ?? 10_000;
  const budgetTimer =
    budgetIntervalMs > 0
      ? setInterval(() => {
          updateBudgetMultiplier({
            redis: moderation.redis,
            budgetPerSec: deps.frameBudgetPerSec,
            backlog: () => frameQueue.getWaitingCount(),
          }).then(
            (multiplier) => {
              if (multiplier > 1) logger.info({ multiplier }, 'frame budget exceeded: stretching');
            },
            (error: unknown) => {
              logger.warn({ err: error }, 'frame budget update failed');
            },
          );
        }, budgetIntervalMs)
      : undefined;
  budgetTimer?.unref();

  return {
    sessionLog,
    frames,
    events,
    reports,
    /** Waits for in-flight jobs to finish, then disconnects. */
    async close(): Promise<void> {
      clearInterval(budgetTimer);
      await Promise.all([...workers.map((worker) => worker.close()), frameQueue.close()]);
    },
  };
}
