import { defineConfig } from 'vitest/config';
import { REPORTERS, tiers } from '../../tests/tiers/projects.js';

export default defineConfig({
  test: { reporters: REPORTERS, testTimeout: 0, projects: tiers({ include: ['src/**/*.test.{ts,mjs}', 'scripts/**/*.test.{ts,mjs}', 'test/**/*.test.{ts,mjs}'], integration: { globalSetup: ['./vitest.temporal-setup.ts'] } }) },
});
