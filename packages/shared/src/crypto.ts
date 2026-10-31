// Server-only (node:crypto). Import via "@app/shared/crypto"; never re-export from index.ts,
// which must stay browser-safe.
import { createHmac } from 'node:crypto';
import { isIPv6 } from 'node:net';

/**
 * HMAC-SHA256 (hex) of an identifier such as a raw IP or device ID. The pepper keeps hashes
 * unlinkable to the raw value without server secrets, so they can be stored and compared
 * (bans, rate limits) while the raw value is never persisted.
 */
export function hmacHash(value: string, pepper: string): string {
  if (pepper.length === 0) throw new Error('hmacHash: pepper must not be empty');
  return createHmac('sha256', pepper).update(value, 'utf8').digest('hex');
}

/**
 * The part of an IP address that identifies a subscriber: IPv4 as is (IPv4-mapped IPv6 too),
 * IPv6 reduced to its /64 prefix — one home or phone gets a whole /64, so per-address bans
 * and rate limits would be trivial to dodge by rotating the interface id.
 */
export function ipSubject(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped?.[1] !== undefined) return mapped[1];
  if (!isIPv6(ip)) return ip;
  const [head = '', tail = ''] = ip.toLowerCase().split('%')[0]?.split('::') ?? [];
  const left = head === '' ? [] : head.split(':');
  const right = tail === '' ? [] : tail.split(':');
  const groups = ip.includes('::')
    ? [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
    : left;
  return `${groups
    .slice(0, 4)
    .map((group) => group.padStart(4, '0'))
    .join(':')}::/64`;
}

/** HMAC of `ipSubject(ip)`: how raw IPs become `ipHash` everywhere (bans, rate limits). */
export function hashIp(ip: string, pepper: string): string {
  return hmacHash(ipSubject(ip), pepper);
}
