export const TRUST_MIN = 0;
export const TRUST_MAX = 100;
/** New visitors start here (Visitor.trustScore default). */
export const TRUST_DEFAULT = 50;

/** Trust change per event (Part 8 rules). */
export const TRUST_DELTAS = {
  report_received: -10,
  auto_flag: -20,
  text_violation: -2,
  /** A session of at least CLEAN_SESSION_MIN_MS without any violation. */
  clean_session: 1,
  /** Repeatedly not uploading the frames the server asked for (D-054). */
  missing_frames: -5,
} as const;

export type TrustEvent = keyof typeof TRUST_DELTAS;

export const CLEAN_SESSION_MIN_MS = 60_000;

export interface TrustThresholds {
  /** Below this: shadow pool. */
  shadowBelow: number;
  /** Below this: `high` sampling tier. */
  highRiskBelow: number;
  /** From this (and no recent reports): `trusted` tier. */
  trustedFrom: number;
}

export const DEFAULT_TRUST_THRESHOLDS: TrustThresholds = {
  shadowBelow: 10,
  highRiskBelow: 40,
  trustedFrom: 70,
};

export function clampTrust(score: number): number {
  return Math.min(TRUST_MAX, Math.max(TRUST_MIN, Math.round(score)));
}

export function trustDelta(event: TrustEvent, times = 1): number {
  return TRUST_DELTAS[event] * times;
}

export function applyTrust(score: number, event: TrustEvent, times = 1): number {
  return clampTrust(score + trustDelta(event, times));
}

/** Shadow pool if shadow-banned or trust fell below the threshold; HARD bans never get here. */
export function poolFor(
  { banType, trust }: { banType: 'HARD' | 'SHADOW' | null; trust: number },
  thresholds: TrustThresholds = DEFAULT_TRUST_THRESHOLDS,
): 'normal' | 'shadow' {
  return banType === 'SHADOW' || trust < thresholds.shadowBelow ? 'shadow' : 'normal';
}

export function isCleanSession({
  durationMs,
  violations,
}: {
  durationMs: number;
  violations: number;
}): boolean {
  return durationMs >= CLEAN_SESSION_MIN_MS && violations === 0;
}
