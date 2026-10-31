import { ADMIN_CSRF_HEADER, reportPageSchema } from '@app/shared';

import { readState, URLS } from './stack.ts';

/** The admin API as the e2e admin (the session opened by global setup), for setup and checks. */
export function adminApi() {
  const { admin, adminSession } = readState();
  const call = async (method: 'GET' | 'POST', route: string, body?: unknown) => {
    const response = await fetch(`${URLS.api}/v1/admin${route}`, {
      method,
      headers: {
        cookie: adminSession.cookie,
        [ADMIN_CSRF_HEADER]: adminSession.csrfToken,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`${method} ${route}: ${String(response.status)}`);
    return (await response.json()) as unknown;
  };
  return {
    credentials: admin,
    reportsAgainst: async (visitorId: string) =>
      reportPageSchema
        .parse(await call('GET', '/reports?limit=100'))
        .items.filter((report) => report.reportedId === visitorId),
    hardBan: (visitorId: string) =>
      call('POST', '/bans', { visitorId, type: 'HARD', durationHours: 24, reason: 'e2e test ban' }),
  };
}
