import { type BrowserContext, test as base } from '@playwright/test';

import { newVisitor, type Visitor } from './visitors.ts';

export { expect } from '@playwright/test';

/**
 * `visitor(name)` opens a stranger in its own browser context. Every context a test opened is
 * closed when it ends — pass or fail — so no searching visitor leaks into the next test's
 * queue (closing sends `chat:end` / `queue:leave` on pagehide, D-077).
 */
export const test = base.extend<{ visitor: (name: string) => Promise<Visitor> }>({
  visitor: async ({ browser }, use) => {
    const opened: BrowserContext[] = [];
    await use(async (name) => {
      const visitor = await newVisitor(browser, name);
      opened.push(visitor.context);
      return visitor;
    });
    await Promise.all(opened.map((context) => context.close().catch(() => undefined)));
  },
});
