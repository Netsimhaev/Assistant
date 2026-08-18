import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // The spine talks to a real Postgres. Tests share one database and clean up
    // per-file, so running files in parallel would interleave truncations.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    env: {
      NODE_ENV: 'test',
    },
  },
});
