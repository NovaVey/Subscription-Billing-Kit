import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Separate from vite.config.ts (dev/build), matching the api workspace's
// convention of dedicated vitest.*.config.ts files. See the /improve audit:
// before this, web/ had zero test files, zero test-runner config, and no
// "test" script - frontend coverage wasn't partial, it was nonexistent.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['./test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
    },
  },
});
