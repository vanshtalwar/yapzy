import { randomUUID } from 'node:crypto';

import { publicConfigSchema, sessionResponseSchema } from '@app/shared';
import { io } from 'socket.io-client';

import { expect, test } from '../support/fixtures.ts';
import { URLS } from '../support/stack.ts';
import { expectInChat, send, startText } from '../support/visitors.ts';

/** A visitor whose tab never answers `match:found` (background tab, dead connection). */
async function ghostVisitor() {
  const { tosVersion } = publicConfigSchema.parse(
    await (await fetch(`${URLS.api}/v1/config`)).json(),
  );
  const response = await fetch(`${URLS.api}/v1/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX', // Cloudflare test secret accepts any token
      ageConfirmed: true,
      tosVersion,
      deviceId: randomUUID(),
    }),
  });
  const { token } = sessionResponseSchema.parse(await response.json());
  const socket = io(URLS.gateway, {
    transports: ['websocket'],
    auth: { token },
    reconnection: false,
  });
  await new Promise<void>((resolve) => {
    socket.once('connect', () => {
      resolve();
    });
  });
  let matched = 0;
  socket.on('match:found', () => (matched += 1)); // …and never sends match:ack
  await socket.timeout(5_000).emitWithAck('queue:join', { mode: 'text', lang: 'en' });
  return { socket, matched: () => matched };
}

test('a tab that never acks its match does not block the other user (D-047)', async ({
  visitor,
}) => {
  const ghost = await ghostVisitor();
  const a = await visitor('A');
  await startText(a); // matched with the ghost, which never acknowledges…
  await expect.poll(() => ghost.matched()).toBe(1);

  // …so after MATCH_ACK_TIMEOUT_MS A is requeued at the head of the queue and meets B.
  const b = await visitor('B');
  await startText(b);
  await expectInChat(b, "You're now chatting", 30_000);
  await send(b, 'hi A, B here');
  await expectInChat(a, 'hi A, B here');
  ghost.socket.disconnect();
});
