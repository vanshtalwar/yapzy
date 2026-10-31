import { DEFAULT_TRUST_THRESHOLDS, type TrustThresholds } from './trust.ts';

/**
 * Risk-based frame sampling (D-054). Each video participant gets an upload interval from
 * their risk tier instead of sampling everyone every 30 s (~23k images/s at 1M users).
 */
export const RISK_TIERS = ['high', 'new', 'normal', 'trusted'] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

export interface RiskProfile {
  trust: number;
  /** ms epoch; null = unknown (treated as new). */
  firstSeenAt: number | null;
  /** Reported or auto-flagged recently: sampled at `high` until then (ms epoch). */
  flaggedUntil: number | null;
  lastReportedAt: number | null;
}

export const NEW_VISITOR_MS = 24 * 60 * 60 * 1000;
export const REPORT_QUIET_MS = 7 * 24 * 60 * 60 * 1000;
/** Trusted participants get at most one frame, this long into the session. */
export const SPOT_CHECK_MS = 10_000;
export const MAX_BUDGET_MULTIPLIER = 64;

export function riskTier(
  profile: RiskProfile,
  {
    now,
    groupCall = false,
    thresholds = DEFAULT_TRUST_THRESHOLDS,
  }: { now: number; groupCall?: boolean; thresholds?: TrustThresholds },
): RiskTier {
  if (groupCall || profile.trust < thresholds.highRiskBelow || (profile.flaggedUntil ?? 0) > now) {
    return 'high';
  }
  if (profile.firstSeenAt === null || now - profile.firstSeenAt < NEW_VISITOR_MS) return 'new';
  const quiet = profile.lastReportedAt === null || now - profile.lastReportedAt > REPORT_QUIET_MS;
  return profile.trust >= thresholds.trustedFrom && quiet ? 'trusted' : 'normal';
}

/**
 * How much a tier's interval is stretched when the global budget is exceeded: the lowest
 * risk tiers first and most, `high` never beyond 2×.
 */
export function stretchFactor(tier: RiskTier, multiplier: number): number {
  const m = Math.min(MAX_BUDGET_MULTIPLIER, Math.max(1, multiplier));
  switch (tier) {
    case 'trusted':
    case 'normal':
      return m;
    case 'new':
      return Math.max(1, m / 2);
    case 'high':
      return Math.min(2, Math.max(1, m / 4));
  }
}

export interface SamplingConfig {
  /** Interval per tier in ms; `trusted: 0` = spot checks only. */
  intervals: Record<RiskTier, number>;
  normalSampleRate: number;
  trustedSpotCheckRate: number;
}

export interface FrameSchedule {
  tier: RiskTier;
  /** null = this participant uploads no frames. */
  frameIntervalMs: number | null;
  /** null = unlimited (until the session ends). */
  maxFrames: number | null;
}

export function frameSchedule(
  tier: RiskTier,
  config: SamplingConfig,
  { multiplier = 1, random = Math.random }: { multiplier?: number; random?: () => number } = {},
): FrameSchedule {
  const stretch = stretchFactor(tier, multiplier);
  const every = (ms: number): FrameSchedule => ({
    tier,
    frameIntervalMs: Math.round(ms * stretch),
    maxFrames: null,
  });
  const none: FrameSchedule = { tier, frameIntervalMs: null, maxFrames: null };
  switch (tier) {
    case 'high':
    case 'new':
      return every(config.intervals[tier]);
    case 'normal':
      return random() < config.normalSampleRate ? every(config.intervals.normal) : none;
    case 'trusted':
      if (config.intervals.trusted > 0) return every(config.intervals.trusted);
      return random() < config.trustedSpotCheckRate / stretch
        ? { tier, frameIntervalMs: SPOT_CHECK_MS, maxFrames: 1 }
        : none;
  }
}

/**
 * Next global multiplier from the measured upload rate (multiplicative, square-root smoothed)
 * and the classifier backlog. 1 = no stretching.
 */
export function nextBudgetMultiplier({
  previous,
  observedPerSec,
  budgetPerSec,
  backlog,
}: {
  previous: number;
  observedPerSec: number;
  budgetPerSec: number;
  backlog: number;
}): number {
  const ratio = Math.max(0.01, observedPerSec / budgetPerSec);
  let next = Math.max(1, previous) * Math.sqrt(ratio);
  // The classifier is falling behind: stretch harder than the upload rate alone suggests.
  if (backlog > budgetPerSec * 30) next *= 1.5;
  return Math.min(MAX_BUDGET_MULTIPLIER, Math.max(1, Number(next.toFixed(3))));
}
