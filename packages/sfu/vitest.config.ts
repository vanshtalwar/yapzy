import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The integration tests share the Janus container and Redis DB 8.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/testing.ts'],
      thresholds: { lines: 70 },
    },
  },
});
