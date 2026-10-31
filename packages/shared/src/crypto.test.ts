import { describe, expect, it } from 'vitest';

import { hashIp, hmacHash, ipSubject } from './crypto.ts';

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

describe('ipSubject / hashIp', () => {
  it('keeps IPv4, unwraps IPv4-mapped IPv6 and reduces IPv6 to its /64', () => {
    expect(ipSubject('203.0.113.7')).toBe('203.0.113.7');
    expect(ipSubject('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(ipSubject('2001:db8:85a3:12::8a2e:370:7334')).toBe('2001:0db8:85a3:0012::/64');
    expect(ipSubject('2001:DB8::1')).toBe('2001:0db8:0000:0000::/64');
    expect(ipSubject('fe80::1%en0')).toBe('fe80:0000:0000:0000::/64');
    expect(ipSubject('::1')).toBe('0000:0000:0000:0000::/64');
  });

  it('gives every address of one /64 the same hash, other prefixes a different one', () => {
    const pepper = 'pepper-0123456789abcdef';
    const home = hashIp('2001:db8:aa:bb::1', pepper);
    expect(hashIp('2001:db8:aa:bb:dead:beef:0:42', pepper)).toBe(home);
    expect(hashIp('2001:db8:aa:bc::1', pepper)).not.toBe(home);
    expect(hashIp('::ffff:198.51.100.4', pepper)).toBe(hashIp('198.51.100.4', pepper));
  });
});
