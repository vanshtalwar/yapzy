import { describe, expect, it } from 'vitest';

import { TokenBucket } from './token-bucket.ts';

describe('TokenBucket', () => {
  it('allows bursts up to capacity, then refills over time', () => {
    let now = 0;
    const bucket = new TokenBucket(3, 2, () => now);
    expect([bucket.take(1), bucket.take(1), bucket.take(1), bucket.take(1)]).toEqual([
      true,
      true,
      true,
      false,
    ]);
    now += 500; // +1 token at 2/s
    expect(bucket.take(1)).toBe(true);
    expect(bucket.take(1)).toBe(false);
  });

  it('supports fractional costs and never exceeds capacity', () => {
    let now = 0;
    const bucket = new TokenBucket(1, 1, () => now);
    now += 60_000;
    for (let i = 0; i < 4; i += 1) expect(bucket.take(0.25)).toBe(true);
    expect(bucket.take(0.25)).toBe(false);
  });
});
