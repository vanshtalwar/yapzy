import { expect, test } from '../support/fixtures.ts';
import {
  expectInChat,
  expectVideoConnected,
  remoteVideoState,
  send,
  startVideo,
} from '../support/visitors.ts';

test('video call connects and frames flow both ways; text chat beside it', async ({ visitor }) => {
  const a = await visitor('A');
  const b = await visitor('B');
  await startVideo(a);
  await startVideo(b);

  await expectVideoConnected(a);
  await expectVideoConnected(b);
  const before = await remoteVideoState(a.page);
  await expect.poll(async () => (await remoteVideoState(a.page)).time).toBeGreaterThan(before.time);

  await send(a, 'hi from the video chat');
  await expectInChat(b, 'hi from the video chat');
});
