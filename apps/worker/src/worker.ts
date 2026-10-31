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

import { purgeExpiredData } from './jobs/retention.ts';
import { persistSessionLog } from './jobs/session-log.ts';
import { createDefaultWorkerMetrics, type WorkerMetrics } from './metrics.ts';
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
  /** How often the retention job runs (BullMQ job scheduler); 0 disables scheduling (tests). */
  retentionEveryMs?: number;
  metrics?: WorkerMetrics;
}

const QUEUE_STATES = ['waiting', 'active', 'delayed', 'failed'] as const;

/** BullMQ consumers. Job payloads are re-validated here: the queue is a trust boundary too. */
export function createWorkers(deps: WorkerDeps) {
  const { prisma, logger } = deps;
  const metrics = deps.metrics ?? createDefaultWorkerMetrics(false);
  const moderation = { ...deps.moderation, observer: deps.moderation.observer ?? metrics.observer };
  const options = (concurrency: number) => ({
    // Workers block on Redis; BullMQ requires unlimited retries per request for them.
    connection: { url: deps.redisUrl, maxRetriesPerRequest: null },
    prefix: BULLMQ_PREFIX,
    concurrency,
  });

  const workers: Worker[] = [];
  function consume<T>(name: string, concurrency: number, run: (job: Job<T>) => Promise<unknown>) {
    const worker = new Worker<T>(name, run, options(concurrency));
    const observe = (job: Job<T>, status: 'completed' | 'failed') => {
      metrics.jobs.inc({ queue: name, status });
      if (job.processedOn !== undefined && job.finishedOn !== undefined) {
        metrics.jobDuration.observe(
          { queue: name, status },
          (job.finishedOn - job.processedOn) / 1_000,
        );
      }
    };
    worker.on('completed', (job) => {
      observe(job, 'completed');
    });
    worker.on('failed', (job, error) => {
      if (job !== undefined) observe(job, 'failed');
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

  const frames = consume<ClassifyFrameJob>(
    QUEUE_NAMES.CLASSIFY_FRAME,
    deps.concurrency,
    async (job) => {
      const outcome = await classifyFrame(moderation, classifyFrameJobSchema.parse(job.data));
      metrics.framesClassified.inc({ outcome });
      return outcome;
    },
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

  const retention = consume<unknown>(QUEUE_NAMES.RETENTION, 1, async () => {
    const purged = await purgeExpiredData({
      prisma,
      objects: moderation.objects,
      evidenceBucket: moderation.buckets.evidence,
      now: moderation.now?.() ?? new Date(),
    });
    metrics.retentionPurged.inc({ kind: 'evidence' }, purged.evidence);
    metrics.retentionPurged.inc({ kind: 'transcript' }, purged.transcripts);
    if (purged.evidence + purged.transcripts > 0) logger.info(purged, 'retention purge');
    return purged;
  });

  // Producer-side handles: queue depths for /metrics, the frame backlog for the budget, and the
  // retention schedule.
  const queues = Object.values(QUEUE_NAMES).map(
    (name) => new Queue(name, { connection: { url: deps.redisUrl }, prefix: BULLMQ_PREFIX }),
  );
  const queueNamed = (name: string) => {
    const queue = queues.find((candidate) => candidate.name === name);
    if (queue === undefined) throw new Error(`unknown queue ${name}`);
    return queue;
  };
  metrics.sources.queueCounts = async () =>
    (
      await Promise.all(
        queues.map(async (queue) => {
          const counts = await queue.getJobCounts(...QUEUE_STATES);
          return QUEUE_STATES.map((state) => ({
            queue: queue.name,
            state,
            count: counts[state] ?? 0,
          }));
        }),
      )
    ).flat();
  const retentionEveryMs = deps.retentionEveryMs ?? 3_600_000;
  if (retentionEveryMs > 0) {
    // Idempotent: every worker instance upserts the same scheduler; BullMQ runs it once.
    queueNamed(QUEUE_NAMES.RETENTION)
      .upsertJobScheduler('retention-purge', { every: retentionEveryMs }, { name: 'purge' })
      .catch((error: unknown) => {
        logger.warn({ err: error }, 'retention schedule failed');
      });
  }

  // Frame budget: the classify-frame backlog is part of the signal.
  const frameQueue = queueNamed(QUEUE_NAMES.CLASSIFY_FRAME);
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
              metrics.frameBudgetMultiplier.set(multiplier);
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
    retention,
    metrics,
    /** Waits for in-flight jobs to finish, then disconnects. */
    async close(): Promise<void> {
      clearInterval(budgetTimer);
      await Promise.all([
        ...workers.map((worker) => worker.close()),
        ...queues.map((queue) => queue.close()),
      ]);
    },
  };
}
