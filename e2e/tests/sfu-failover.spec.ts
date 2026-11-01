import { spawnSync } from 'node:child_process';

import { expect, test } from '../support/fixtures.ts';
import { janusNodes, janusRooms } from '../support/janus.ts';
import { ownsStack, portInUse, restartGateway } from '../support/stack.ts';
import { expectVideoConnected, remoteVideoState, startVideo } from '../support/visitors.ts';

// Part 11 failover drill. Runs only with a second Janus node:
//   pnpm sfu:multi:up
//   JANUS_NODES='[{"id":"janus-1",…7188"},{"id":"janus-2","wsUrl":"ws://localhost:8189","adminUrl":"ws://localhost:7189"}]' \
//     pnpm --filter @app/e2e exec playwright test tests/sfu-failover.spec.ts
// Stops the Janus container hosting the call (`docker compose stop`) and starts it again.

const SERVICE_OF: Record<string, string> = { 'janus-1': 'janus', 'janus-2': 'janus-2' };

function compose(...args: string[]): void {
  const result = spawnSync(
    'docker',
    [
      'compose',
      '--env-file',
      '.env',
      '-f',
      'infra/docker/docker-compose.yml',
      '--profile',
      'sfu-multi',
      ...args,
    ],
    { cwd: new URL('../..', import.meta.url).pathname, encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`docker compose ${args.join(' ')}: ${result.stderr}`);
}

test('stopping the Janus node of a call moves it to the other node; the call recovers', async ({
  visitor,
}) => {
  const { nodes } = janusNodes();
  const second = nodes[1];
  test.skip(
    second === undefined || !(await portInUse(Number(new URL(second.adminUrl).port))),
    'needs a second Janus node (pnpm sfu:multi:up + JANUS_NODES)',
  );
  test.skip(!ownsStack(), 'restarts the gateway: needs the stack started by the tests');
  test.setTimeout(120_000);
  await restartGateway({ DEV_FORCE_SFU: 'true' });

  const a = await visitor('A');
  const b = await visitor('B');
  await startVideo(a);
  await startVideo(b);
  for (const v of [a, b]) {
    await expect(v.page.locator('[data-topology]')).toHaveAttribute('data-topology', 'sfu', {
      timeout: 30_000,
    });
    await expectVideoConnected(v);
  }

  const hosting = await (async () => {
    for (const [index, node] of nodes.entries()) {
      const rooms = await janusRooms(index);
      if ([...rooms.values()].some((publishers) => publishers.length === 2)) return { index, node };
    }
    throw new Error('call not found on any Janus node');
  })();
  const otherIndex = hosting.index === 0 ? 1 : 0;
  const service = SERVICE_OF[hosting.node.id];
  if (service === undefined) throw new Error(`no compose service for ${hosting.node.id}`);

  const stoppedAt = Date.now();
  compose('stop', service);
  try {
    // Frames advance again on both sides once they rejoined on the other node.
    for (const v of [a, b]) {
      const frozen = await remoteVideoState(v.page);
      await expect
        .poll(async () => (await remoteVideoState(v.page)).time, { timeout: 30_000 })
        .toBeGreaterThan(frozen.time + 1);
    }
    const recoveredMs = Date.now() - stoppedAt;
    test
      .info()
      .annotations.push({ type: 'recovered-after', description: `${String(recoveredMs)} ms` });
    expect(recoveredMs).toBeLessThan(20_000);
    await expect
      .poll(async () => [...(await janusRooms(otherIndex)).values()].some((p) => p.length === 2))
      .toBe(true);
    await expect(a.page.getByText('Stranger has left the chat.')).toHaveCount(0);
  } finally {
    compose('up', '-d', '--wait', service);
    await restartGateway();
  }
});
