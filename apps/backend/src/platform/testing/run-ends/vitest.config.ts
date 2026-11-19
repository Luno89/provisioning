import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ['*.fixture.ts'],
    testTimeout: 0,
    hookTimeout: 0,
    globalSetup: ['../../../../vitest.global-setup.ts'],
  },
});
