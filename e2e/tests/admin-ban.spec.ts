import { adminApi } from '../support/admin-api.ts';
import { expect, test } from '../support/fixtures.ts';
import { URLS } from '../support/stack.ts';
import { expectInChat, startText, visitorIdOf } from '../support/visitors.ts';

test('a moderator bans a live user from a report; their chat ends at once', async ({
  browser,
  visitor,
}) => {
  // A reports B; B goes on to chat with C.
  const a = await visitor('A');
  const b = await visitor('B');
  await startText(a);
  await startText(b);
  await expectInChat(a, "You're now chatting");
  await a.page.getByRole('button', { name: 'Report' }).click();
  await a.page.getByRole('dialog').getByRole('radio', { name: 'Harassment or bullying' }).click();
  await a.page.getByRole('dialog').getByRole('button', { name: 'Report and leave' }).click();
  await a.context.close();
  const c = await visitor('C');
  await startText(c);
  await expectInChat(c, "You're now chatting");

  const targetId = await visitorIdOf(b.page);
  const admin = adminApi();
  await expect.poll(async () => (await admin.reportsAgainst(targetId)).length).toBe(1);
  const [report] = await admin.reportsAgainst(targetId);

  // The moderator signs in, opens the report and hard-bans for 24 h.
  const moderator = await browser.newContext();
  const page = await moderator.newPage();
  await page.goto(`${URLS.admin}/login`);
  await page.getByLabel('Email').fill(admin.credentials.email);
  await page.getByLabel('Password').fill(admin.credentials.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await page.goto(`${URLS.admin}/reports/${report?.id ?? ''}`);
  await page.getByRole('button', { name: 'Hard ban' }).click();
  await page.getByRole('button', { name: '24 hours' }).click();
  await page.getByRole('button', { name: 'Ban', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm ban' }).click();
  await expect(page.getByText('Ban applied').first()).toBeVisible();

  await expect(b.page.getByText('You can’t chat right now')).toBeVisible();
  await expectInChat(c, 'Stranger has left the chat.');
  await moderator.close();
});
