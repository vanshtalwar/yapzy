import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Test files share one Redis DB (FLUSHDB between tests), so they must not run concurrently.
    fileParallelism: false,
    // Business logic ≥ 70 % of lines (Part 10); server.ts is process wiring only.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/test/**', 'src/server.ts'],
      thresholds: { lines: 70 },
    },
  },
});
