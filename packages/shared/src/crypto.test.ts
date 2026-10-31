import { describe, expect, it } from 'vitest';

import { hmacHash } from './crypto.ts';

describe('hmacHash', () => {
  it('matches the RFC 4231 HMAC-SHA256 test vector', () => {
    expect(hmacHash('what do ya want for nothing?', 'Jefe')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });

  it('is deterministic per pepper and differs across peppers', () => {
    const a = hmacHash('203.0.113.7', 'pepper-one-0123456789');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(hmacHash('203.0.113.7', 'pepper-one-0123456789')).toBe(a);
    expect(hmacHash('203.0.113.7', 'pepper-two-0123456789')).not.toBe(a);
    expect(a).not.toContain('203.0.113.7');
  });

  it('rejects an empty pepper', () => {
    expect(() => hmacHash('x', '')).toThrow(/pepper/);
  });
});
