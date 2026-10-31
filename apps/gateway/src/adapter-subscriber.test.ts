import { type Redis } from '@app/redis';
import { describe, expect, it } from 'vitest';

import { watchShardedSubscriber } from './adapter-subscriber.ts';

/** An ioredis stand-in whose (un)subscribe replies the test releases one by one. */
function fakeClient() {
  const replies: (() => void)[] = [];
  const reply = () =>
    new Promise<void>((resolve) => {
      replies.push(resolve);
    });
  const client = {
    calls: [] as string[],
    marker: 'kept',
    ssubscribe(...channels: string[]) {
      this.calls.push(`ssubscribe ${channels.join(',')}`);
      return reply();
    },
    sunsubscribe(...channels: string[]) {
      this.calls.push(`sunsubscribe ${channels.join(',')}`);
      return reply();
    },
  };
  return { client, release: () => replies.shift()?.() };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('watched sharded subscriber', () => {
  it('tracks every (un)subscription until Redis answers and passes everything else through', async () => {
    const { client, release } = fakeClient();
    let clock = 0;
    const watched = watchShardedSubscriber(client as unknown as Redis, () => clock);
    const subscriber = watched.subscriber as unknown as typeof client;
    void subscriber.ssubscribe('room:a');
    clock = 1_000;
    void subscriber.sunsubscribe('room:b');
    expect(client.calls).toEqual(['ssubscribe room:a', 'sunsubscribe room:b']);
    expect(subscriber.marker).toBe('kept');
    expect(watched.pendingCount()).toBe(2);

    clock = 20_000;
    expect(watched.oldestPendingMs()).toBe(20_000);
    expect(watched.oldestPending()).toMatchObject({ channels: ['room:a'], op: 'ssubscribe' });

    release();
    await tick();
    expect(watched.oldestPendingMs()).toBe(19_000);
    release();
    await tick();
    expect(watched.pendingCount()).toBe(0);
    expect(watched.oldestPendingMs()).toBe(0);
  });
});
