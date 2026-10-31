import { describe, expect, it } from 'vitest';

import {
  CHAT_MODES,
  ERROR_CODES,
  ErrorCode,
  errorCodeSchema,
  interestSchema,
  interestsSchema,
  isErrorCode,
  langSchema,
  MAX_INTEREST_LENGTH,
  MAX_INTERESTS,
  MAX_MESSAGE_LENGTH,
  messageTextSchema,
  SUPPORTED_LANGS,
} from './index.ts';

describe('constants', () => {
  it('matches the limits in the reference design', () => {
    expect(MAX_MESSAGE_LENGTH).toBe(500);
    expect(MAX_INTERESTS).toBe(5);
    expect(MAX_INTEREST_LENGTH).toBe(24);
    expect(CHAT_MODES).toEqual(['text', 'video']);
  });

  it('lists unique two-letter language codes including English', () => {
    expect(new Set(SUPPORTED_LANGS).size).toBe(SUPPORTED_LANGS.length);
    expect(SUPPORTED_LANGS).toContain('en');
    for (const lang of SUPPORTED_LANGS) expect(lang).toMatch(/^[a-z]{2}$/);
  });
});

describe('error codes', () => {
  it('uses each code as its own value', () => {
    for (const [key, value] of Object.entries(ErrorCode)) expect(value).toBe(key);
    expect(ERROR_CODES).toContain('RATE_LIMITED');
  });

  it('narrows unknown values', () => {
    expect(isErrorCode('BANNED')).toBe(true);
    expect(isErrorCode('NOPE')).toBe(false);
    expect(isErrorCode(42)).toBe(false);
    expect(errorCodeSchema.safeParse('MESSAGE_BLOCKED').success).toBe(true);
  });
});

describe('schemas', () => {
  it('normalizes interests and drops duplicates', () => {
    expect(interestsSchema.parse([' Music', 'music', 'Indie Games'])).toEqual([
      'music',
      'indie games',
    ]);
  });

  it('rejects too many, too long, empty or symbol-only interests', () => {
    expect(interestsSchema.safeParse(['a', 'b', 'c', 'd', 'e', 'f']).success).toBe(false);
    expect(interestSchema.safeParse('x'.repeat(MAX_INTEREST_LENGTH + 1)).success).toBe(false);
    expect(interestSchema.safeParse('   ').success).toBe(false);
    expect(interestSchema.safeParse('<script>').success).toBe(false);
  });

  it('accepts non-latin interests', () => {
    expect(interestSchema.parse('音楽')).toBe('音楽');
  });

  it('bounds message text after trimming', () => {
    expect(messageTextSchema.parse('  hi  ')).toBe('hi');
    expect(messageTextSchema.safeParse('   ').success).toBe(false);
    expect(messageTextSchema.safeParse('x'.repeat(MAX_MESSAGE_LENGTH + 1)).success).toBe(false);
    expect(messageTextSchema.safeParse(`  ${'x'.repeat(MAX_MESSAGE_LENGTH)}  `).success).toBe(true);
  });

  it('validates modes and languages', () => {
    expect(langSchema.safeParse('en').success).toBe(true);
    expect(langSchema.safeParse('xx').success).toBe(false);
  });
});
