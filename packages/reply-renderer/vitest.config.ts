import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globalSetup: ['./src/test-global-setup.ts'],
    testTimeout: 15_000,
  },
});
