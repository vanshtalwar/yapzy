import { afterEach, describe, expect, it, vi } from 'vitest';

import { getAcceptedTosVersion, setAcceptedTosVersion } from './consent.ts';
import { getDeviceId } from './device.ts';
import { DEFAULT_PREFERENCES, loadPreferences, savePreferences } from './preferences.ts';
import { clearSession, getSession, getToken, saveSession } from './session-token.ts';
import { readItem, readJson, removeItem, writeItem } from './storage.ts';

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  clearSession();
  vi.restoreAllMocks();
});

describe('storage helpers', () => {
  it('read, write, remove and parse JSON, tolerating garbage', () => {
    expect(writeItem('local', 'k', '{"a":1}')).toBe(true);
    expect(readItem('local', 'k')).toBe('{"a":1}');
    expect(readJson('local', 'k')).toEqual({ a: 1 });
    writeItem('session', 'bad', '{not json');
    expect(readJson('session', 'bad')).toBeNull();
    removeItem('local', 'k');
    expect(readItem('local', 'k')).toBeNull();
    expect(readJson('local', 'missing')).toBeNull();
  });

  it('keeps working when the browser refuses storage', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(writeItem('local', 'k', 'v')).toBe(false);
    expect(readItem('local', 'k')).toBeNull();
    expect(() => {
      removeItem('local', 'k');
    }).not.toThrow();
  });
});

describe('device id', () => {
  it('is a stable random UUID per browser', () => {
    const id = getDeviceId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(getDeviceId()).toBe(id);
    localStorage.setItem('rc.deviceId', 'not-a-uuid'); // tampered → replaced
    expect(getDeviceId()).not.toBe('not-a-uuid');
  });

  it('falls back to one id per tab without storage', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    expect(getDeviceId()).toBe(getDeviceId());
  });
});

describe('session token', () => {
  const session = (expiresInMs: number) => ({
    token: 'jwt',
    visitorId: 'visitor-1',
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
  });

  it('is kept in memory and sessionStorage until it is about to expire', () => {
    saveSession(session(3_600_000));
    expect(getToken()).toBe('jwt');
    expect(JSON.parse(sessionStorage.getItem('rc.session') ?? '{}')).toMatchObject({
      visitorId: 'visitor-1',
    });
    clearSession();
    expect(getSession()).toBeNull();
  });

  it('treats tokens expiring within a minute as gone', () => {
    saveSession(session(30_000));
    expect(getToken()).toBeNull();
    expect(sessionStorage.getItem('rc.session')).toBeNull();
  });

  it('restores a stored session after a reload, ignoring invalid data', () => {
    sessionStorage.setItem('rc.session', JSON.stringify(session(3_600_000)));
    expect(getSession()?.visitorId).toBe('visitor-1');
    clearSession();
    sessionStorage.setItem('rc.session', '{"token":1}');
    expect(getSession()).toBeNull();
  });
});

describe('preferences & consent', () => {
  it('round-trips preferences and falls back to defaults for invalid data', () => {
    expect(loadPreferences()).toEqual(DEFAULT_PREFERENCES);
    const preferences = {
      mode: 'video' as const,
      lang: 'de' as const,
      interests: ['jazz'],
      autoRequeue: false,
    };
    savePreferences(preferences);
    expect(loadPreferences()).toEqual(preferences);
    localStorage.setItem('rc.preferences', JSON.stringify({ mode: 'audio' }));
    expect(loadPreferences()).toEqual(DEFAULT_PREFERENCES);
  });

  it('remembers the accepted terms version', () => {
    expect(getAcceptedTosVersion()).toBeNull();
    setAcceptedTosVersion('2026-10');
    expect(getAcceptedTosVersion()).toBe('2026-10');
  });
});
