import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Files share Redis DB 13 and real gateway instances; run them one at a time.
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
