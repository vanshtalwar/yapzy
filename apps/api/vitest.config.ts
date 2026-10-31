import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Test files share one Redis DB (FLUSHDB between tests), so they must not run concurrently.
    fileParallelism: false,
  },
});
