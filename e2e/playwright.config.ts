import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against the real stack (Part 10). `support/global-setup.ts` starts api,
 * gateway, worker, web and admin from their builds (`pnpm build` first; `pnpm test:e2e` does
 * it) on the usual ports, unless E2E_REUSE_STACK=1. Infra must be up (`pnpm infra:up`).
 *
 * One worker: every test shares the same matchmaking queues, so parallel tests would match
 * each other's visitors. E2E_BROWSER_CHANNEL=chrome uses an installed Chrome instead of
 * Playwright's Chromium (`pnpm --filter @app/e2e exec playwright install chromium`).
 */
const channel = process.env.E2E_BROWSER_CHANNEL;

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  retries: process.env.CI === undefined ? 0 : 1,
  reporter: process.env.CI === undefined ? [['list']] : [['github'], ['html', { open: 'never' }]],
  globalSetup: './support/global-setup.ts',
  globalTeardown: './support/global-teardown.ts',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    permissions: ['camera', 'microphone'],
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], ...(channel === undefined ? {} : { channel }) },
    },
  ],
});
