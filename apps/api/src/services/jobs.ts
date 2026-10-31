import {
  BULLMQ_PREFIX,
  type ClassifyFrameJob,
  QUEUE_NAMES,
  type ReportFiledJob,
} from '@app/shared/jobs';
import { Queue } from 'bullmq';

/** Jobs the API hands to the worker; injected so tests can record them. */
export interface ApiJobs {
  reportFiled(job: ReportFiledJob): Promise<void>;
  classifyFrame(job: ClassifyFrameJob): Promise<void>;
  close(): Promise<void>;
}

const defaultJobOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: { age: 3_600, count: 10_000 },
  removeOnFail: { age: 7 * 24 * 3_600 },
} as const;

export function createBullJobs(redisUrl: string): ApiJobs {
  const connection = { url: redisUrl };
  const reports = new Queue<ReportFiledJob>(QUEUE_NAMES.REPORT_FILED, {
    connection,
    prefix: BULLMQ_PREFIX,
    defaultJobOptions,
  });
  const frames = new Queue<ClassifyFrameJob>(QUEUE_NAMES.CLASSIFY_FRAME, {
    connection,
    prefix: BULLMQ_PREFIX,
    // A lost frame is not worth many retries; it expires with the bucket lifecycle anyway.
    defaultJobOptions: { ...defaultJobOptions, attempts: 2 },
  });
  return {
    async reportFiled(job) {
      await reports.add(QUEUE_NAMES.REPORT_FILED, job, { jobId: job.reportId });
    },
    async classifyFrame(job) {
      await frames.add(QUEUE_NAMES.CLASSIFY_FRAME, job);
    },
    async close() {
      await Promise.all([reports.close(), frames.close()]);
    },
  };
}

/** Test double: remembers jobs instead of queueing them. */
export function createRecordingJobs() {
  const recorded = { reportFiled: [] as ReportFiledJob[], classifyFrame: [] as ClassifyFrameJob[] };
  const jobs: ApiJobs & { recorded: typeof recorded } = {
    recorded,
    reportFiled: (job) => {
      recorded.reportFiled.push(job);
      return Promise.resolve();
    },
    classifyFrame: (job) => {
      recorded.classifyFrame.push(job);
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  };
  return jobs;
}
