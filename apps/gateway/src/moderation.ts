import { type GatewayEnv } from '@app/env';
import {
  createRiskProfiles,
  createTextFilter,
  type FrameSchedule,
  frameSchedule,
  poolFor,
  riskTier,
  TRUST_DEFAULT,
  type TrustThresholds,
} from '@app/moderation';
import { MOD_BUDGET_MULTIPLIER_KEY, type Redis, trustKey } from '@app/redis';
import { type ChatMode, type MatchPool } from '@app/shared';
import { type ModerationEventJob } from '@app/shared/jobs';

/** The budget multiplier is re-read at most this often (it changes every ~10 s). */
const MULTIPLIER_CACHE_MS = 5_000;

export const NO_FRAMES: FrameSchedule = { tier: 'normal', frameIntervalMs: null, maxFrames: null };

/**
 * Trust & safety on the real-time path (Part 8): text filter, pool and frame-sampling
 * decisions from Redis caches only (never Postgres), and moderation events handed to the
 * worker through BullMQ.
 */
export function createGatewayModeration(deps: {
  redis: Redis;
  config: Pick<
    GatewayEnv,
    | 'TRUST_SHADOW_BELOW'
    | 'TRUST_HIGH_RISK_BELOW'
    | 'TRUST_TRUSTED_FROM'
    | 'MOD_FRAME_INTERVALS_MS'
    | 'MOD_NORMAL_SAMPLE_RATE'
    | 'MOD_TRUSTED_SPOTCHECK_RATE'
  >;
  enqueueEvent: (job: ModerationEventJob) => Promise<void>;
  now: () => Date;
  random?: () => number;
}) {
  const { redis, config } = deps;
  const textFilter = createTextFilter();
  const risk = createRiskProfiles({ redis });
  const thresholds: TrustThresholds = {
    shadowBelow: config.TRUST_SHADOW_BELOW,
    highRiskBelow: config.TRUST_HIGH_RISK_BELOW,
    trustedFrom: config.TRUST_TRUSTED_FROM,
  };
  const sampling = {
    intervals: config.MOD_FRAME_INTERVALS_MS,
    normalSampleRate: config.MOD_NORMAL_SAMPLE_RATE,
    trustedSpotCheckRate: config.MOD_TRUSTED_SPOTCHECK_RATE,
  };
  let multiplier = { value: 1, readAt: Number.NEGATIVE_INFINITY };

  async function budgetMultiplier(): Promise<number> {
    const now = deps.now().getTime();
    if (now - multiplier.readAt > MULTIPLIER_CACHE_MS) {
      const stored = Number((await redis.get(MOD_BUDGET_MULTIPLIER_KEY)) ?? '1');
      multiplier = { value: Number.isFinite(stored) && stored >= 1 ? stored : 1, readAt: now };
    }
    return multiplier.value;
  }

  /** Cached trust (written by the API at session start and by the worker on changes). */
  async function trustOf(visitorId: string): Promise<number> {
    const cached = Number((await redis.get(trustKey(visitorId))) ?? Number.NaN);
    return Number.isFinite(cached) ? cached : TRUST_DEFAULT;
  }

  return {
    filterText: textFilter,
    trustOf,

    async poolFor(visitorId: string, banType: 'HARD' | 'SHADOW' | null): Promise<MatchPool> {
      return poolFor({ banType, trust: await trustOf(visitorId) }, thresholds);
    },

    /** Frame sampling for one participant of a new session (D-054). */
    async scheduleFor(
      visitorId: string,
      { mode, groupCall = false }: { mode: ChatMode; groupCall?: boolean },
    ): Promise<FrameSchedule> {
      if (mode !== 'video') return NO_FRAMES;
      const profile = await risk.profile(visitorId, await trustOf(visitorId));
      const tier = riskTier(profile, { now: deps.now().getTime(), groupCall, thresholds });
      return frameSchedule(tier, sampling, {
        multiplier: await budgetMultiplier(),
        ...(deps.random === undefined ? {} : { random: deps.random }),
      });
    },

    /** Schedule after a report / NSFW signal in the session ("switch to high immediately"). */
    async highRisk(): Promise<FrameSchedule> {
      return frameSchedule('high', sampling, { multiplier: await budgetMultiplier() });
    },

    recordEvent(job: ModerationEventJob): Promise<void> {
      return deps.enqueueEvent(job);
    },
  };
}

export type GatewayModeration = ReturnType<typeof createGatewayModeration>;
