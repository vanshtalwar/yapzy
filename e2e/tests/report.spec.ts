import { adminApi } from '../support/admin-api.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectInChat, send, startText, visitorIdOf } from '../support/visitors.ts';

test('reporting a stranger ends the chat and files a report with the transcript', async ({
  visitor,
}) => {
  const a = await visitor('A');
  const b = await visitor('B');
  await startText(a);
  await startText(b);
  await expectInChat(a, "You're now chatting");
  await send(b, 'you are boring, go away');
  await expectInChat(a, 'you are boring, go away');

  await a.page.getByRole('button', { name: 'Report' }).click();
  const dialog = a.page.getByRole('dialog');
  await dialog.getByRole('radio', { name: 'Harassment or bullying' }).click();
  await dialog.getByRole('button', { name: 'Report and leave' }).click();
  await expect(a.page.getByText('Thanks for reporting').first()).toBeVisible();
  await expectInChat(b, 'Stranger has left the chat.');

  const reportedId = await visitorIdOf(b.page);
  const admin = adminApi();
  await expect
    .poll(async () => (await admin.reportsAgainst(reportedId)).map((report) => report.reason))
    .toEqual(['HARASSMENT']);
});
