import { afterAll, describe, expect, it } from 'vitest';

import { type GwControlMessage, publishControl, subscribeControl } from './control.ts';
import { createTestRedis } from './testing.ts';

const publisher = createTestRedis('test:control:pub');
const subscriber = createTestRedis('test:control:sub');
// Unique per run: pub/sub is not scoped by DB index, so never use the real gw:control here.
const channel = `test:gw:control:${String(process.pid)}:${String(Date.now())}`;

afterAll(async () => {
  await Promise.all([publisher.quit(), subscriber.quit()]);
});

function nextEvent<T>(register: (resolve: (value: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('timed out waiting for pub/sub event'));
    }, 2_000);
    register((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

describe('gw:control pub/sub (integration)', () => {
  it('delivers typed messages and drops malformed ones', async () => {
    let onMessage: (message: GwControlMessage) => void = () => undefined;
    let onInvalid: (error: unknown) => void = () => undefined;
    const unsubscribe = await subscribeControl(
      subscriber,
      {
        onMessage: (message) => {
          onMessage(message);
        },
        onInvalid: (error) => {
          onInvalid(error);
        },
      },
      channel,
    );

    const kick: GwControlMessage = {
      type: 'kick_visitor',
      originNodeId: 'node-a',
      visitorId: 'v1',
      reason: 'session_replaced',
      keepSocketId: 'sock-2',
    };
    const received = nextEvent<GwControlMessage>((resolve) => (onMessage = resolve));
    await publishControl(publisher, kick, channel);
    expect(await received).toEqual(kick);

    const invalid = nextEvent<unknown>((resolve) => (onInvalid = resolve));
    await publisher.publish(channel, JSON.stringify({ type: 'self_destruct' }));
    await expect(invalid).resolves.toBeDefined();

    await unsubscribe();
    expect(await publisher.publish(channel, '{}')).toBe(0);
  });

  it('validates outgoing messages, including ban targets', async () => {
    await expect(
      publishControl(
        publisher,
        {
          type: 'ban_applied',
          originNodeId: 'node-a',
          banId: 'b1',
          banType: 'HARD',
          expiresAt: null,
        },
        channel,
      ),
    ).rejects.toThrow(/visitorId, deviceIdHash or ipHash/);

    await expect(
      publishControl(
        publisher,
        {
          type: 'ban_applied',
          originNodeId: 'node-a',
          banId: 'b1',
          banType: 'SHADOW',
          ipHash: 'f'.repeat(64),
          expiresAt: '2026-11-01T00:00:00.000Z',
        },
        channel,
      ),
    ).resolves.toBeTypeOf('number');
  });
});
