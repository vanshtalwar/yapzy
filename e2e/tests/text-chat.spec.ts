import { expect, test } from '../support/fixtures.ts';
import { chatLog, expectInChat, send, startText } from '../support/visitors.ts';

test('two strangers chat: text both ways (shown as text), links blocked, typing, stop', async ({
  visitor,
}) => {
  const a = await visitor('A');
  const b = await visitor('B');
  await startText(a);
  await startText(b);
  await expectInChat(a, "You're now chatting");
  await expectInChat(b, "You're now chatting");

  await send(a, 'hello from A');
  await expectInChat(b, 'hello from A');

  // User content is text, never HTML.
  await send(b, '<b>bold?</b> <img src=x onerror=alert(1)>');
  await expectInChat(a, '<b>bold?</b>');
  expect(await chatLog(a.page).innerHTML()).not.toMatch(/<b>bold\?<\/b>|<img/);

  // Links are blocked by the text filter: the sender is told, the stranger never sees them.
  await send(b, 'see https://example.com');
  await expect(
    b.page.getByText('Not sent — this message breaks the community guidelines'),
  ).toBeVisible();
  await send(b, 'after the link');
  await expectInChat(a, 'after the link');
  expect(await chatLog(a.page).innerText()).not.toContain('example.com');

  await b.page.getByRole('textbox', { name: 'Message' }).pressSequentially('typ', { delay: 50 });
  await expect(a.page.getByText('typing…').first()).toBeVisible();

  await a.page.getByRole('button', { name: 'Stop' }).click();
  await expectInChat(a, 'You left the chat.');
  await expectInChat(b, 'Stranger has left the chat.');
});
