import { describe, expect, it, vi } from 'vitest';

import { createIceServerCache } from './ice-servers.ts';

const credentials = {
  iceServers: [
    { urls: ['stun:localhost:3478'] },
    { urls: ['turn:localhost:3478?transport=udp'], username: '1:v', credential: 'secret' },
  ],
  ttlSeconds: 600,
};

describe('ICE server cache', () => {
  it('fetches once for concurrent callers and caches until 60 s before expiry', async () => {
    let now = 0;
    const fetchCredentials = vi.fn(() => Promise.resolve(credentials));
    const cache = createIceServerCache({ fetchCredentials, now: () => now });
    expect(cache.peek()).toBeNull();
    const [a, b] = await Promise.all([cache.get(), cache.get()]);
    expect(a).toBe(b);
    expect(a[1]).toEqual({
      urls: ['turn:localhost:3478?transport=udp'],
      username: '1:v',
      credential: 'secret',
    });
    expect(a[0]).toEqual({ urls: ['stun:localhost:3478'] });
    expect(fetchCredentials).toHaveBeenCalledTimes(1);

    now = 539_000;
    expect(cache.refreshInMs()).toBe(1_000);
    await cache.get();
    expect(fetchCredentials).toHaveBeenCalledTimes(1);
    now = 540_000;
    await cache.get();
    expect(fetchCredentials).toHaveBeenCalledTimes(2);
  });

  it('does not cache failures', async () => {
    const fetchCredentials = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(credentials);
    const cache = createIceServerCache({ fetchCredentials });
    await expect(cache.get()).rejects.toThrow('offline');
    await expect(cache.get()).resolves.toHaveLength(2);
  });
});
