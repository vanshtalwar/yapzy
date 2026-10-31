import { afterEach, describe, expect, it, vi } from 'vitest';

import { api, ApiError } from './api.ts';

function respond(status: number, body: unknown) {
  const fetchMock = vi.fn(() =>
    Promise.resolve(
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('REST client', () => {
  it('validates responses with the shared schemas', async () => {
    respond(200, { online: 42 });
    expect(await api.getOnlineCount()).toBe(42);
    respond(200, { online: 'many' });
    await expect(api.getOnlineCount()).rejects.toThrow();
  });

  it('turns error envelopes into ApiError with the server code and details', async () => {
    respond(403, {
      error: { code: 'BANNED', message: 'Access denied', requestId: 'r1', expiresAt: null },
    });
    const error = await api
      .createSession({
        turnstileToken: 't',
        ageConfirmed: true,
        tosVersion: 'v',
        deviceId: crypto.randomUUID(),
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 403,
      code: 'BANNED',
      details: { requestId: 'r1', expiresAt: null },
    });
  });

  it('reports network failures and unexpected bodies distinctly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );
    await expect(api.getConfig()).rejects.toMatchObject({ status: 0, code: 'SERVICE_UNAVAILABLE' });
    respond(500, { nope: true });
    await expect(api.getConfig()).rejects.toMatchObject({ status: 500, code: 'INTERNAL_ERROR' });
  });

  it('sends the bearer token and report frames as multipart', async () => {
    const fetchMock = respond(201, { reportId: '0199a3b2-7c4d-7e5f-8a9b-0c1d2e3f4a5b' });
    const id = await api.report(
      'jwt',
      { sessionId: 's', reportedParticipantId: 'p', reason: 'OTHER' },
      [new Blob(['x'], { type: 'image/jpeg' })],
    );
    expect(id).toBe('0199a3b2-7c4d-7e5f-8a9b-0c1d2e3f4a5b');
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer jwt');
    expect((init.body as FormData).getAll('frames')).toHaveLength(1);
  });

  it('maps frame-upload answers to ok / stop / skip', async () => {
    const frame = new Blob(['x'], { type: 'image/jpeg' });
    respond(202, { accepted: true });
    expect(await api.uploadFrame('jwt', 's', frame)).toBe('ok');
    respond(403, { error: { code: 'FORBIDDEN', message: 'no', requestId: 'r' } });
    expect(await api.uploadFrame('jwt', 's', frame)).toBe('stop');
    respond(429, { error: { code: 'RATE_LIMITED', message: 'No more frames', requestId: 'r' } });
    expect(await api.uploadFrame('jwt', 's', frame)).toBe('stop');
    respond(429, { error: { code: 'RATE_LIMITED', message: 'Too early', requestId: 'r' } });
    expect(await api.uploadFrame('jwt', 's', frame)).toBe('skip');
    respond(500, null);
    expect(await api.uploadFrame('jwt', 's', frame)).toBe('skip');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );
    expect(await api.uploadFrame('jwt', 's', frame)).toBe('skip');
  });
});
