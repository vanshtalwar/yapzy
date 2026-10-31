import { type QueueBucket } from '@app/redis';
import { CHAT_MODES, type ChatMode, SUPPORTED_LANGS, type SupportedLang } from '@app/shared';

export interface BucketConfig {
  region: string;
  buckets: number;
  bucketsByQueue: Record<string, number>;
}

/** `MM_BUCKETS_BY_QUEUE["<mode>:<lang>"]` or `MM_BUCKETS` (D-052). */
export function bucketCountFor(config: BucketConfig, mode: ChatMode, lang: SupportedLang): number {
  return config.bucketsByQueue[`${mode}:${lang}`] ?? config.buckets;
}

/** Every bucket of every queue family in this region (the sweeper visits each). */
export function allQueueBuckets(config: BucketConfig): QueueBucket[] {
  return (['normal', 'shadow'] as const).flatMap((pool) =>
    CHAT_MODES.flatMap((mode) =>
      SUPPORTED_LANGS.flatMap((lang) =>
        Array.from({ length: bucketCountFor(config, mode, lang) }, (_, bucket) => ({
          region: config.region,
          pool,
          mode,
          lang,
          bucket,
        })),
      ),
    ),
  );
}
