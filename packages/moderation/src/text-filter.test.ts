import { describe, expect, it } from 'vitest';

import { createTextFilter } from './text-filter.ts';

const filter = createTextFilter();
const reasonsOf = (text: string) => filter(text).reasons;

describe('text filter', () => {
  it('allows ordinary conversation', () => {
    for (const text of [
      'hi! where are you from?',
      'I love music, mostly jazz. you?',
      'ok. me too',
      'it is 10:30 here and I was born in 1999',
      'my phone died yesterday lol',
      'I am 3.5 hours ahead of you',
      'the classic assassin movie',
      'my snapchat broke',
    ]) {
      expect(filter(text), text).toEqual({ action: 'allow', reasons: [] });
    }
  });

  it('blocks links, including obfuscated ones', () => {
    for (const text of [
      'check https://example.com/x',
      'go to www.example.org',
      'example.com',
      'visit EXAMPLE.COM now',
      'w w w . x . c o m',
      'x dot com',
      'x (dot) com',
      'x [.] io',
      'x . me',
      'hxxp://bad.example',
      'h t t p s : / / evil.link',
      'my site is cute-pics.xyz',
    ]) {
      expect(filter(text), text).toMatchObject({ action: 'block' });
      expect(reasonsOf(text), text).toContain('link');
    }
  });

  it('lets allow-listed domains through', () => {
    const custom = createTextFilter({ allowedDomains: ['randomchat.example'] });
    expect(custom('read help.randomchat.example/rules').action).toBe('allow');
    expect(custom('read evil.example.com').action).toBe('block');
  });

  it('blocks emails, phone numbers and handles', () => {
    expect(reasonsOf('mail me jane.doe@gmail.com')).toContain('email');
    expect(reasonsOf('jane (at) mail.com')).toContain('email');
    expect(reasonsOf('write to janedoe at gmail')).toContain('email');
    expect(reasonsOf('call +1 (555) 123-4567')).toContain('phone');
    expect(reasonsOf('my number 0151 2345 6789')).toContain('phone');
    expect(reasonsOf('add me on snap')).toContain('handle');
    expect(reasonsOf('hmu on telegram')).toContain('handle');
    expect(reasonsOf('my insta is jane_doe99')).toContain('handle');
    expect(reasonsOf('ig: jane.d')).toContain('handle');
    expect(reasonsOf('find me @janedoe')).toContain('handle');
    expect(reasonsOf('discord jane#1234')).toContain('handle');
  });

  it('blocks slurs and self-harm encouragement, masks other profanity', () => {
    expect(filter('you are a n1gger')).toMatchObject({ action: 'block', reasons: ['hate'] });
    expect(filter('just kys')).toMatchObject({ action: 'block', reasons: ['abuse'] });
    expect(filter('go   kill yourself')).toMatchObject({ action: 'block', reasons: ['abuse'] });
    const masked = filter('this is fucking great, sh1t');
    expect(masked.action).toBe('mask');
    expect(masked.reasons).toEqual(['profanity']);
    expect(masked.masked).not.toMatch(/fuck|sh1t/i);
    expect(masked.masked).toMatch(/^this is \*+ing great, \*+$/);
  });

  it('is configurable', () => {
    const lenient = createTextFilter({
      blockLinks: false,
      blockContacts: false,
      maskProfanity: false,
    });
    expect(lenient('see example.com or call 555 123 4567').action).toBe('allow');
    expect(lenient('fucking hell').action).toBe('allow');
    const strict = createTextFilter({ extraBlockedTerms: ['buy followers'] });
    expect(strict('Buy   followers here')).toMatchObject({ reasons: ['blocked_term'] });
  });
});
