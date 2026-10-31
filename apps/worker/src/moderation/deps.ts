import { type PrismaClient } from '@app/db';
import { type Logger } from '@app/logger';
import {
  type BanService,
  type HashMatcher,
  type ImageClassifier,
  type RiskProfiles,
  type TrustStore,
} from '@app/moderation';
import { type Redis } from '@app/redis';
import { type ObjectStore } from '@app/storage';

export interface ModerationConfig {
  /** Classifier labels at or above this score count as a violation. */
  flagThreshold: number;
  /** Violations at or above this score also shadow-ban the visitor. */
  autoShadowScore: number;
  /** Distinct reporters within 24 h that shadow-ban a visitor. */
  reportThreshold: number;
  autoBanHours: number;
}

/** Hooks for metrics (`moderation_actions_total`, `reports_total{source="auto"}`). */
export interface ModerationObserver {
  action(source: string, action: string): void;
  autoReport(reason: string): void;
}

export interface ModerationDeps {
  prisma: PrismaClient;
  redis: Redis;
  objects: ObjectStore;
  buckets: { evidence: string; frames: string };
  classifier: ImageClassifier;
  hashMatcher: HashMatcher;
  bans: BanService;
  trust: TrustStore;
  risk: RiskProfiles;
  config: ModerationConfig;
  logger: Pick<Logger, 'info' | 'warn' | 'error' | 'debug'>;
  observer?: ModerationObserver;
  now?: () => Date;
}

export const DAY_MS = 24 * 60 * 60 * 1000;
