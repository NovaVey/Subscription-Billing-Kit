import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // These tests share one real, stateful Postgres database (no time
    // budget per §9 - that's the tradeoff). Running files in parallel
    // would let one file's rows (e.g. the reaper test's "processing" rows)
    // leak into another's queries against the same tables.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary'],
      reportsDirectory: './coverage/integration',
      include: ['src/**/*.ts'],
      exclude: ['src/db/migrations/**', 'src/index.ts'],
    },
  },
});
