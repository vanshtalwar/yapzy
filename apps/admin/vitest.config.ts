import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    // Business logic (lib/*.ts) ≥ 70 % of lines (Part 10); the React hook/context files are
    // UI glue covered by the Playwright suite in e2e/.
    coverage: {
      provider: 'v8',
      include: ['lib/**/*.ts'],
      exclude: ['lib/**/*.test.ts', 'lib/use-api.ts'],
      thresholds: { lines: 70 },
    },
  },
});
