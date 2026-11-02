import { defineConfig } from 'vitest/config';
import { REPORTERS, tiers } from '../../tests/tiers/projects.js';

export default defineConfig({
  test: { reporters: REPORTERS, projects: tiers({ include: ['src/**/*.test.{ts,mjs}', 'scripts/**/*.test.{ts,mjs}', 'test/**/*.test.{ts,mjs}'] }) },
});
