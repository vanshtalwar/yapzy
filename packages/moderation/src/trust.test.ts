import { describe, expect, it } from 'vitest';

import { flaggedLabel, MockImageClassifier } from './classifier.ts';
import { NoopHashMatcher } from './hash-matcher.ts';
import { applyTrust, isCleanSession, poolFor } from './trust.ts';

describe('trust rules', () => {
  it('applies the event deltas and clamps to 0–100', () => {
    expect(applyTrust(50, 'report_received')).toBe(40);
    expect(applyTrust(50, 'auto_flag')).toBe(30);
    expect(applyTrust(50, 'text_violation')).toBe(48);
    expect(applyTrust(50, 'clean_session')).toBe(51);
    expect(applyTrust(100, 'clean_session')).toBe(100);
    expect(applyTrust(5, 'auto_flag')).toBe(0);
    expect(applyTrust(50, 'text_violation', 3)).toBe(44);
  });

  it('only counts violation-free sessions of at least 60 s as clean', () => {
    expect(isCleanSession({ durationMs: 60_000, violations: 0 })).toBe(true);
    expect(isCleanSession({ durationMs: 59_999, violations: 0 })).toBe(false);
    expect(isCleanSession({ durationMs: 600_000, violations: 1 })).toBe(false);
  });

  it('puts shadow-banned and low-trust visitors in the shadow pool', () => {
    expect(poolFor({ banType: null, trust: 50 })).toBe('normal');
    expect(poolFor({ banType: 'SHADOW', trust: 90 })).toBe('shadow');
    expect(poolFor({ banType: null, trust: 9 })).toBe('shadow');
    expect(poolFor({ banType: null, trust: 10 })).toBe('normal');
    expect(
      poolFor(
        { banType: null, trust: 15 },
        { shadowBelow: 20, highRiskBelow: 40, trustedFrom: 70 },
      ),
    ).toBe('shadow');
  });
});

describe('classifier and hash matcher stand-ins', () => {
  it('the mock classifier is safe by default and flags forced visitors deterministically', async () => {
    const classifier = new MockImageClassifier(['visitor-x']);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff]);
    const safe = await classifier.classify(jpeg, { visitorId: 'visitor-y' });
    expect(flaggedLabel(safe.labels, 0.8)).toBeNull();
    const flagged = await classifier.classify(jpeg, { visitorId: 'visitor-x' });
    expect(flaggedLabel(flagged.labels, 0.8)).toEqual({ name: 'sexual_explicit', score: 0.99 });
    expect(flaggedLabel(flagged.labels, 0.995)).toBeNull();
    expect(await new NoopHashMatcher().match()).toEqual({ matched: false });
  });
});
