import { expect, test } from '../support/fixtures.ts';
import { chatLog, expectInChat, send, startText } from '../support/visitors.ts';

test('Next re-matches with someone else; the skipped stranger is told', async ({ visitor }) => {
  const a = await visitor('A');
  const b = await visitor('B');
  await startText(a);
  await startText(b);
  await expectInChat(a, "You're now chatting");
  await expectInChat(b, "You're now chatting");

  const c = await visitor('C');
  await startText(c);
  await expect(c.page.getByText('Looking for someone').first()).toBeVisible();

  // Next needs a confirming second press; A is not re-matched with B (recent pair), so with C.
  await a.page.getByRole('button', { name: 'Next', exact: true }).click();
  await a.page.getByRole('button', { name: 'Really skip?' }).click();
  await expectInChat(b, 'Stranger has left the chat.');
  await expectInChat(c, "You're now chatting");
  await expect(chatLog(a.page).getByText("You're now chatting")).toHaveCount(1); // fresh chat

  await send(a, 'hello C');
  await expectInChat(c, 'hello C');
  expect(await chatLog(b.page).innerText()).not.toContain('hello C');
});
