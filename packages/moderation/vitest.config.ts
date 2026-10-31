import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // bans.test.ts and ban-service.test.ts share Redis DB 12 and flush it before each test.
    fileParallelism: false,
    // Coverage target (Part 10): ≥ 90 % of lines (`pnpm test:coverage`).
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      thresholds: { lines: 90 },
    },
  },
});
