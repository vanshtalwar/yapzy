import { Counter, createMetricsRegistry, Gauge, Histogram, type Registry } from '@app/metrics';

import { type ModerationObserver } from './moderation/deps.ts';

export interface QueueCount {
  queue: string;
  state: string;
  count: number;
}

/** Prometheus metrics of the worker (`GET /metrics` on WORKER_METRICS_PORT). */
export function createWorkerMetrics(registry: Registry) {
  /** Read at scrape time; createWorkers points it at its BullMQ queues. */
  const sources = { queueCounts: (): Promise<QueueCount[]> => Promise.resolve([]) };
  const moderationActions = new Counter({
    name: 'moderation_actions_total',
    help: 'Moderation actions by source and kind',
    labelNames: ['source', 'action'] as const,
    registers: [registry],
  });
  const reports = new Counter({
    name: 'reports_total',
    help: 'Reports filed (source=auto: created by the classifier)',
    labelNames: ['reason', 'source'] as const,
    registers: [registry],
  });
  const observer: ModerationObserver = {
    action: (source, action) => {
      moderationActions.inc({ source, action });
    },
    autoReport: (reason) => {
      reports.inc({ reason, source: 'auto' });
    },
  };
  return {
    registry,
    sources,
    observer,
    moderationActions,
    reports,
    jobDuration: new Histogram({
      name: 'bullmq_job_duration_seconds',
      help: 'Processing time per job, by queue and final status',
      labelNames: ['queue', 'status'] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
      registers: [registry],
    }),
    jobs: new Counter({
      name: 'bullmq_jobs_total',
      help: 'Jobs processed, by queue and status (completed, failed)',
      labelNames: ['queue', 'status'] as const,
      registers: [registry],
    }),
    queueJobs: new Gauge({
      name: 'bullmq_queue_jobs',
      help: 'Jobs per queue and state (waiting, active, delayed, failed)',
      labelNames: ['queue', 'state'] as const,
      registers: [registry],
      async collect() {
        for (const { queue, state, count } of await sources.queueCounts()) {
          this.set({ queue, state }, count);
        }
      },
    }),
    framesClassified: new Counter({
      name: 'moderation_frames_classified_total',
      help: 'Sampled frames checked by the worker, by outcome (clean, flagged, hash_match, missing)',
      labelNames: ['outcome'] as const,
      registers: [registry],
    }),
    frameBudgetMultiplier: new Gauge({
      name: 'moderation_frame_budget_multiplier',
      help: 'Sampling stretch factor published for the gateways (1 = within budget)',
      registers: [registry],
    }),
    retentionPurged: new Counter({
      name: 'retention_purged_total',
      help: 'Expired data removed by the retention job (evidence, transcripts)',
      labelNames: ['kind'] as const,
      registers: [registry],
    }),
  };
}

export type WorkerMetrics = ReturnType<typeof createWorkerMetrics>;

export function createDefaultWorkerMetrics(withProcessMetrics: boolean): WorkerMetrics {
  return createWorkerMetrics(
    createMetricsRegistry({ service: 'worker', defaultMetrics: withProcessMetrics }),
  );
}
