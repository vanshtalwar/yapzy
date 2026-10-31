import { okSchema } from '@app/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api, ApiError, query, setCsrfToken, setUnauthorizedHandler } from './api.ts';
import { formatTime, priorityTone, REASON_LABELS, shortId } from './labels.ts';

function respond(status: number, body: unknown) {
  const fetchMock = vi.fn(() => Promise.resolve(Response.json(body, { status })));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  setCsrfToken(null);
  setUnauthorizedHandler(null);
});

describe('admin API client', () => {
  it('sends the session cookie and, on POST, the CSRF token', async () => {
    const fetchMock = respond(200, { ok: true });
    setCsrfToken('csrf-1');
    expect(await api.post('/reports/x/assign', okSchema)).toEqual({ ok: true });
    await api.get('/stats', okSchema);
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    const [postUrl, post] = calls[0] ?? ['', {}];
    const [, get] = calls[1] ?? ['', {}];
    expect(postUrl).toBe('http://localhost:4000/v1/admin/reports/x/assign');
    expect(post.credentials).toBe('include');
    expect(new Headers(post.headers).get('x-admin-csrf')).toBe('csrf-1');
    expect(post.body).toBe('{}');
    expect(new Headers(get.headers).has('x-admin-csrf')).toBe(false);
  });

  it('maps error envelopes and calls the 401 handler (not for failed logins)', async () => {
    const unauthorized = vi.fn();
    setUnauthorizedHandler(unauthorized);
    respond(401, { error: { code: 'UNAUTHORIZED', message: 'Not signed in', requestId: 'r' } });
    await expect(api.get('/auth/me', okSchema)).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHORIZED',
    });
    expect(unauthorized).toHaveBeenCalledTimes(1);
    respond(401, { error: { code: 'INVALID_CREDENTIALS', message: 'Wrong', requestId: 'r' } });
    await expect(api.post('/auth/login', okSchema, {})).rejects.toBeInstanceOf(ApiError);
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });

  it('reports network failures and unexpected bodies', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );
    await expect(api.get('/stats', okSchema)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    respond(502, { html: true });
    await expect(api.get('/stats', okSchema)).rejects.toMatchObject({
      status: 502,
      code: 'INTERNAL_ERROR',
    });
  });

  it('builds query strings from defined values only', () => {
    expect(query({ status: 'OPEN', cursor: undefined, minPriority: 0, q: '', x: null })).toBe(
      '?status=OPEN&minPriority=0',
    );
    expect(query({})).toBe('');
  });
});

describe('labels', () => {
  it('maps reasons, priorities and ids for display', () => {
    expect(REASON_LABELS.MINOR_SAFETY).toBe('Minor safety');
    expect([priorityTone(100), priorityTone(50), priorityTone(10)]).toEqual([
      'danger',
      'warning',
      'muted',
    ]);
    expect(shortId('0199a3b2-7c4d-7e5f')).toBe('0199a3b2');
    expect(formatTime('2026-10-31T12:00:00.000Z')).toMatch(/\d/);
  });
});
