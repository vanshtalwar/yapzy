import { type Locator } from '@playwright/test';

import { expect, test } from '../support/fixtures.ts';
import { janusRooms } from '../support/janus.ts';
import { chatLog, expectVideoConnected, startVideo, type Visitor } from '../support/visitors.ts';

// Part 12: group video calls of up to four people through Janus.

/** Landing page: video mode and "Let video calls of 3–4 people add me" (a saved preference). */
async function allowGroupCalls(visitor: Visitor): Promise<void> {
  const { page } = visitor;
  await page.goto('/');
  await page.getByRole('radio', { name: /Video chat/ }).click();
  const toggle = page.getByRole('switch', { name: 'Let video calls of 3–4 people add me' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
}

const stage = (visitor: Visitor) => visitor.page.locator('[data-participants]');
/** The others' videos (the own preview is "Your camera"). */
const remoteVideos = (visitor: Visitor): Locator =>
  visitor.page.locator('video[aria-label$="’s camera"]');

const videoStates = (visitor: Visitor) =>
  remoteVideos(visitor).evaluateAll((videos: HTMLVideoElement[]) =>
    videos.map((video) => ({
      label: video.getAttribute('aria-label') ?? '',
      width: video.videoWidth,
      time: video.currentTime,
    })),
  );

/** In a call of `size` people and rendering every other participant's video. */
async function expectCallOf(visitor: Visitor, size: number): Promise<void> {
  await expect(stage(visitor)).toHaveAttribute('data-participants', String(size), {
    timeout: 45_000,
  });
  await expect
    .poll(async () => (await videoStates(visitor)).filter((video) => video.width > 0).length, {
      timeout: 30_000,
    })
    .toBe(size - 1);
}

/** Every remote video keeps playing (its time moves on). */
async function expectStillPlaying(visitor: Visitor): Promise<void> {
  const before = await videoStates(visitor);
  await expect
    .poll(async () => {
      const after = await videoStates(visitor);
      return after.every((video, index) => video.time > (before[index]?.time ?? Infinity));
    })
    .toBe(true);
}

/** `asker` presses "Add a person"; everyone else in the call accepts. */
async function addPerson(asker: Visitor, others: Visitor[]): Promise<void> {
  await asker.page.getByRole('button', { name: 'Add a person' }).click();
  await expect(
    asker.page.getByRole('status').filter({ hasText: 'Waiting for everyone to agree' }),
  ).toBeVisible();
  for (const visitor of others) {
    const banner = visitor.page.getByRole('status').filter({ hasText: 'wants to add someone' });
    await banner.getByRole('button', { name: 'Accept' }).click();
  }
}

const publisherCounts = async () => [...(await janusRooms()).values()].map((p) => p.length);

test('group call: two strangers add a third and a fourth; one leaves, the others stay', async ({
  visitor,
}) => {
  test.setTimeout(240_000);
  const a = await visitor('A');
  const b = await visitor('B');
  const c = await visitor('C');
  const d = await visitor('D');

  // A and B: an ordinary P2P call.
  await startVideo(a);
  await startVideo(b);
  for (const v of [a, b]) {
    await expectVideoConnected(v);
    await expect(stage(v)).toHaveAttribute('data-topology', 'mesh');
  }

  // C is searching and lets group calls add them; A asks, B agrees → Janus, then C joins.
  await allowGroupCalls(c);
  await startVideo(c);
  await addPerson(a, [b]);
  for (const v of [a, b, c]) {
    await expect(stage(v)).toHaveAttribute('data-topology', 'sfu', { timeout: 30_000 });
    await expectCallOf(v, 3);
  }
  await expect(chatLog(a.page).getByText('Stranger 2 joined the call.')).toBeVisible();
  await expect(
    chatLog(c.page).getByText('You joined a group call with 2 strangers. Say hi!'),
  ).toBeVisible();

  // D is searching; this time the newcomer C asks and both A and B agree.
  await allowGroupCalls(d);
  await startVideo(d);
  await addPerson(c, [a, b]);
  for (const v of [a, b, c, d]) await expectCallOf(v, 4);
  await expect.poll(publisherCounts, { timeout: 20_000 }).toContain(4);
  // Four people is the limit.
  await expect(a.page.getByRole('button', { name: 'Add a person' })).toBeDisabled();

  // D leaves: A, B and C carry on in the same call.
  await d.page.getByRole('button', { name: 'Stop' }).click();
  for (const v of [a, b, c]) {
    await expect(chatLog(v.page).getByText(/left the call\./)).toBeVisible();
    await expectCallOf(v, 3);
    await expectStillPlaying(v);
  }
  await expect.poll(publisherCounts, { timeout: 20_000 }).toContain(3);
  await expect(a.page.getByRole('button', { name: 'Add a person' })).toBeEnabled();
});
