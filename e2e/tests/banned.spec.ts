import { adminApi } from '../support/admin-api.ts';
import { expect, test } from '../support/fixtures.ts';
import { startText, visitorIdOf } from '../support/visitors.ts';

test('a hard-banned visitor sees the blocked screen, live and after reloading', async ({
  visitor,
}) => {
  const v = await visitor('V');
  await startText(v);
  await expect(v.page.getByText('Looking for someone').first()).toBeVisible();

  const admin = adminApi();
  await admin.hardBan(await visitorIdOf(v.page));
  await expect(v.page.getByText('You can’t chat right now')).toBeVisible();

  // The token still exists in the tab; the gateway refuses it at the handshake.
  await v.page.reload();
  await expect(v.page.getByText('You can’t chat right now')).toBeVisible();
});
