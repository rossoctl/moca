import { defineConfig } from 'vitest/config';

export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['./test/setup.ts'],
    // Under load the sbx and app tests run far past the 5 s default. The sbx tests run git
    // synchronously, and a test that blocks the event loop past its timeout fails even if it then
    // finishes.
    testTimeout: 30_000,
  },
});
