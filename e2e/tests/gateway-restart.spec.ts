import { expect, test } from '../support/fixtures.ts';
import { readState, restartGateway } from '../support/stack.ts';
import {
  expectInChat,
  expectVideoConnected,
  remoteVideoState,
  send,
  startVideo,
} from '../support/visitors.ts';

test('a gateway restart mid-call keeps the video connected and text resumes (D-046)', async ({
  visitor,
}) => {
  test.skip(!readState().owned, 'needs the stack started by the tests (E2E_REUSE_STACK unset)');
  const a = await visitor('A');
  const b = await visitor('B');
  await startVideo(a);
  await startVideo(b);
  await expectVideoConnected(a);
  await expectVideoConnected(b);

  // Media is peer-to-peer: it keeps flowing while signaling is down.
  const before = await remoteVideoState(a.page);
  await restartGateway();
  const after = await remoteVideoState(a.page);
  expect(after.width).toBeGreaterThan(0);
  expect(after.time).toBeGreaterThan(before.time);
  await expect(a.page.locator('[data-rtc-state]').first()).toHaveAttribute(
    'data-rtc-state',
    'connected',
  );

  // Signaling reconnects and the session resumes: text flows again, both ways.
  await expect(a.page.getByText('Reconnecting to RandomChat…')).toBeHidden({ timeout: 30_000 });
  await send(a, 'still here after the restart');
  await expectInChat(b, 'still here after the restart', 30_000);
  await send(b, 'me too');
  await expectInChat(a, 'me too');
});
