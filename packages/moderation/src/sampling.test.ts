import { describe, expect, it } from 'vitest';

import {
  frameSchedule,
  NEW_VISITOR_MS,
  nextBudgetMultiplier,
  type RiskProfile,
  riskTier,
  type SamplingConfig,
  SPOT_CHECK_MS,
  stretchFactor,
} from './sampling.ts';

const NOW = Date.parse('2026-10-31T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const profile = (change: Partial<RiskProfile> = {}): RiskProfile => ({
  trust: 50,
  firstSeenAt: NOW - 30 * DAY,
  flaggedUntil: null,
  lastReportedAt: null,
  ...change,
});
const config: SamplingConfig = {
  intervals: { high: 20_000, new: 30_000, normal: 120_000, trusted: 0 },
  normalSampleRate: 0.3,
  trustedSpotCheckRate: 0.1,
};

describe('risk tiers', () => {
  it('assigns high, new, normal and trusted', () => {
    expect(riskTier(profile({ trust: 39 }), { now: NOW })).toBe('high');
    expect(riskTier(profile({ flaggedUntil: NOW + 1 }), { now: NOW })).toBe('high');
    expect(riskTier(profile({ firstSeenAt: NOW - NEW_VISITOR_MS + 1 }), { now: NOW })).toBe('new');
    expect(riskTier(profile({ firstSeenAt: null }), { now: NOW })).toBe('new');
    expect(riskTier(profile(), { now: NOW })).toBe('normal');
    expect(riskTier(profile({ trust: 70 }), { now: NOW })).toBe('trusted');
    expect(riskTier(profile({ trust: 90, lastReportedAt: NOW - 2 * DAY }), { now: NOW })).toBe(
      'normal',
    );
    expect(riskTier(profile({ trust: 90, lastReportedAt: NOW - 8 * DAY }), { now: NOW })).toBe(
      'trusted',
    );
  });

  it('puts every participant of a group call at the high tier', () => {
    expect(riskTier(profile({ trust: 95 }), { now: NOW, groupCall: true })).toBe('high');
  });

  it('a report or flag switches the visitor to high until it expires', () => {
    const reported = profile({ trust: 95, flaggedUntil: NOW + DAY });
    expect(riskTier(reported, { now: NOW })).toBe('high');
    expect(riskTier(reported, { now: NOW + DAY + 1 })).toBe('trusted');
  });
});

describe('frame schedules', () => {
  it('maps tiers to intervals, sampling rates and spot checks', () => {
    expect(frameSchedule('high', config)).toEqual({
      tier: 'high',
      frameIntervalMs: 20_000,
      maxFrames: null,
    });
    expect(frameSchedule('new', config)).toEqual({
      tier: 'new',
      frameIntervalMs: 30_000,
      maxFrames: null,
    });
    expect(frameSchedule('normal', config, { random: () => 0.29 }).frameIntervalMs).toBe(120_000);
    expect(frameSchedule('normal', config, { random: () => 0.3 }).frameIntervalMs).toBeNull();
    expect(frameSchedule('trusted', config, { random: () => 0.05 })).toEqual({
      tier: 'trusted',
      frameIntervalMs: SPOT_CHECK_MS,
      maxFrames: 1,
    });
    expect(frameSchedule('trusted', config, { random: () => 0.1 }).frameIntervalMs).toBeNull();
  });

  it('stretches the lowest tiers first and never `high` beyond 2×', () => {
    expect([1, 2, 4, 8, 16, 1000].map((m) => stretchFactor('normal', m))).toEqual([
      1, 2, 4, 8, 16, 64,
    ]);
    expect([1, 2, 4, 8, 16].map((m) => stretchFactor('new', m))).toEqual([1, 1, 2, 4, 8]);
    expect([1, 2, 4, 8, 16, 64].map((m) => stretchFactor('high', m))).toEqual([1, 1, 1, 2, 2, 2]);
    expect(frameSchedule('high', config, { multiplier: 64 }).frameIntervalMs).toBe(40_000);
    expect(
      frameSchedule('normal', config, { multiplier: 4, random: () => 0 }).frameIntervalMs,
    ).toBe(480_000);
    // Spot checks become rarer, not more frequent.
    expect(
      frameSchedule('trusted', config, { multiplier: 4, random: () => 0.05 }).frameIntervalMs,
    ).toBeNull();
  });

  it('computes the global multiplier from the upload rate and the classifier backlog', () => {
    expect(
      nextBudgetMultiplier({ previous: 1, observedPerSec: 200, budgetPerSec: 50, backlog: 0 }),
    ).toBe(2);
    expect(
      nextBudgetMultiplier({ previous: 2, observedPerSec: 50, budgetPerSec: 50, backlog: 0 }),
    ).toBe(2);
    expect(
      nextBudgetMultiplier({ previous: 4, observedPerSec: 10, budgetPerSec: 50, backlog: 0 }),
    ).toBeLessThan(2);
    expect(
      nextBudgetMultiplier({ previous: 1, observedPerSec: 0, budgetPerSec: 50, backlog: 0 }),
    ).toBe(1);
    expect(
      nextBudgetMultiplier({ previous: 2, observedPerSec: 50, budgetPerSec: 50, backlog: 5_000 }),
    ).toBe(3);
    expect(
      nextBudgetMultiplier({ previous: 64, observedPerSec: 1e6, budgetPerSec: 50, backlog: 0 }),
    ).toBe(64);
  });
});
