import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Under load the seed and patch tests run far past the 5 s default. They run bash and git
    // synchronously, and a test that blocks the event loop past its timeout fails even if it then
    // finishes.
    testTimeout: 30_000,
  },
});
