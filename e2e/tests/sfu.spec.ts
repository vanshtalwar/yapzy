import { expect, test } from '../support/fixtures.ts';
import { janusRooms } from '../support/janus.ts';
import { ownsStack, restartGateway } from '../support/stack.ts';
import {
  expectVideoConnected,
  remoteVideoState,
  startVideo,
  type Visitor,
} from '../support/visitors.ts';

// Part 11: calls through Janus (the dev container from `pnpm infra:up`).

/** Test-only instrumentation: keep every RTCPeerConnection to read its stats later. */
function recordPeerConnections(): void {
  const Native = window.RTCPeerConnection;
  const all: RTCPeerConnection[] = [];
  Object.assign(window, { __pcs: all });
  window.RTCPeerConnection = class extends Native {
    constructor(configuration?: RTCConfiguration) {
      super(configuration);
      all.push(this);
    }
  };
}

/** Test-only: this visitor can't reach Janus (its client WebSocket port is refused). */
function blockJanus(): void {
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    constructor(url: string | URL, protocols?: string | string[]) {
      if (String(url).includes(':8188'))
        throw new DOMException('blocked by the test', 'SecurityError');
      super(url, protocols);
    }
  };
}

/** Remote endpoints (address:port) of the selected candidate pair of every connected PC. */
const remoteEndpoints = (visitor: Visitor) =>
  visitor.page.evaluate(async () => {
    const pcs = (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs;
    const endpoints: { port: number; address: string }[] = [];
    for (const pc of pcs) {
      if (pc.connectionState !== 'connected') continue;
      const report = await pc.getStats();
      let pairId: string | undefined;
      report.forEach((stat: { type: string; selectedCandidatePairId?: string }) => {
        if (stat.type === 'transport' && stat.selectedCandidatePairId)
          pairId = stat.selectedCandidatePairId;
      });
      const pair =
        pairId === undefined ? undefined : (report.get(pairId) as { remoteCandidateId: string });
      const remote =
        pair === undefined
          ? undefined
          : (report.get(pair.remoteCandidateId) as { port: number; address: string });
      if (remote !== undefined) endpoints.push({ port: remote.port, address: remote.address });
    }
    return endpoints;
  });

/** Starts timing remote frames (requestVideoFrameCallback); `gap()` = longest pause in ms. */
async function watchFrames(visitor: Visitor) {
  await visitor.page.evaluate(() => {
    const times: number[] = [];
    Object.assign(window, { __frames: times });
    const tick = () => {
      const video = document.querySelector<HTMLVideoElement>(
        'video[aria-label="Stranger’s camera"]',
      );
      if (video === null) {
        requestAnimationFrame(tick);
        return;
      }
      video.requestVideoFrameCallback((now) => {
        times.push(now);
        tick();
      });
    };
    tick();
  });
  return {
    gap: () =>
      visitor.page.evaluate(() => {
        const times = (window as unknown as { __frames: number[] }).__frames;
        let longest = 0;
        for (let i = 1; i < times.length; i += 1)
          longest = Math.max(longest, (times[i] ?? 0) - (times[i - 1] ?? 0));
        return { longest, frames: times.length };
      }),
  };
}

const topology = (visitor: Visitor) => visitor.page.locator('[data-topology]');

test.describe('Janus SFU', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(() => !ownsStack(), 'restarts the gateway: needs the stack started by the tests');

  test.afterAll(async () => {
    await restartGateway(); // back to the default configuration for the other specs
  });

  test('DEV_FORCE_SFU: a two-person call runs through Janus', async ({ visitor }) => {
    await restartGateway({ DEV_FORCE_SFU: 'true' });
    const a = await visitor('A');
    const b = await visitor('B');
    for (const v of [a, b]) await v.context.addInitScript(recordPeerConnections);
    await startVideo(a);
    await startVideo(b);
    for (const v of [a, b]) {
      await expect(topology(v)).toHaveAttribute('data-topology', 'sfu', { timeout: 30_000 });
      await expectVideoConnected(v);
    }
    const before = await remoteVideoState(a.page);
    await expect
      .poll(async () => (await remoteVideoState(a.page)).time)
      .toBeGreaterThan(before.time);

    // webrtc-internals equivalent: every connected PeerConnection talks to Janus (its RTP range).
    for (const v of [a, b]) {
      const endpoints = await remoteEndpoints(v);
      expect(endpoints.length).toBeGreaterThanOrEqual(2); // publisher + subscriber
      for (const { port } of endpoints) {
        expect(port).toBeGreaterThanOrEqual(20_000);
        expect(port).toBeLessThanOrEqual(20_100);
      }
    }
    // And Janus has the room with both participants publishing.
    await expect
      .poll(async () =>
        [...(await janusRooms()).values()].some((publishers) => publishers.length === 2),
      )
      .toBe(true);
  });

  test('a P2P call switches to Janus mid-call without a visible freeze', async ({ visitor }) => {
    await restartGateway();
    const a = await visitor('A');
    const b = await visitor('B');
    for (const v of [a, b]) await v.context.addInitScript(recordPeerConnections);
    await startVideo(a);
    await startVideo(b);
    for (const v of [a, b]) {
      await expectVideoConnected(v);
      await expect(topology(v)).toHaveAttribute('data-topology', 'mesh');
    }
    const frames = await Promise.all([watchFrames(a), watchFrames(b)]);
    await a.page.waitForTimeout(1_000);

    const answer = await a.page.evaluate(() =>
      (
        window as unknown as { randomchat: { upgradeToSfu(): Promise<string> } }
      ).randomchat.upgradeToSfu(),
    );
    expect(answer).toBe('switching to Janus…');
    for (const v of [a, b]) {
      await expect(topology(v)).toHaveAttribute('data-topology', 'sfu', { timeout: 15_000 });
    }
    await a.page.waitForTimeout(2_000);
    for (const [index, watch] of frames.entries()) {
      const { longest, frames: count } = await watch.gap();
      test.info().annotations.push({
        type: 'longest-frame-gap',
        description: `${index === 0 ? 'A' : 'B'}: ${String(Math.round(longest))} ms over ${String(count)} frames`,
      });
      expect(count).toBeGreaterThan(30);
      expect(longest).toBeLessThan(1_500); // spec: no freeze longer than ~1 s
    }
    for (const v of [a, b]) {
      const ports = (await remoteEndpoints(v)).map((endpoint) => endpoint.port);
      expect(ports.every((port) => port >= 20_000 && port <= 20_100)).toBe(true); // P2P closed
    }
  });

  test('a switch that cannot complete rolls back; the P2P call keeps running', async ({
    visitor,
  }) => {
    const a = await visitor('A');
    const b = await visitor('B');
    await b.context.addInitScript(blockJanus);
    await startVideo(a);
    await startVideo(b);
    for (const v of [a, b]) await expectVideoConnected(v);
    await a.page.evaluate(() =>
      (
        window as unknown as { randomchat: { upgradeToSfu(): Promise<string> } }
      ).randomchat.upgradeToSfu(),
    );
    await expect(topology(a)).toHaveAttribute('data-switching', 'true', { timeout: 5_000 });
    // SFU_UPGRADE_TIMEOUT_MS (10 s): B never gets onto Janus → call:topology mesh.
    await expect(topology(a)).not.toHaveAttribute('data-switching', 'true', { timeout: 20_000 });
    for (const v of [a, b]) {
      await expect(topology(v)).toHaveAttribute('data-topology', 'mesh');
      const before = await remoteVideoState(v.page);
      await expect
        .poll(async () => (await remoteVideoState(v.page)).time)
        .toBeGreaterThan(before.time);
    }
    await expect(a.page.getByText('Stranger has left the chat.')).toHaveCount(0);
  });
});
