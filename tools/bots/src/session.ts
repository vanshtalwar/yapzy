import { randomUUID } from 'node:crypto';

import { publicConfigSchema, sessionResponseSchema } from '@app/shared';

/**
 * Starts an anonymous session exactly like the web app: fetch the ToS version, then POST
 * /v1/session with a fresh device id. In development the Turnstile test secret accepts any token.
 */
export async function startSession(apiUrl: string): Promise<{ token: string; visitorId: string }> {
  const config = publicConfigSchema.parse(await (await fetch(`${apiUrl}/v1/config`)).json());
  const response = await fetch(`${apiUrl}/v1/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX',
      ageConfirmed: true,
      tosVersion: config.tosVersion,
      deviceId: randomUUID(),
    }),
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    throw new Error(
      `POST /v1/session failed (${String(response.status)}): ${JSON.stringify(body)}`,
    );
  }
  return sessionResponseSchema.parse(body);
}
