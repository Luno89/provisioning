import { defineConfig } from 'vitest/config';
import { tiers } from '../../tests/tiers/projects.js';

export default defineConfig({
  test: { projects: tiers({ include: ['src/**/*.test.{ts,mjs}', 'scripts/**/*.test.{ts,mjs}', 'test/**/*.test.{ts,mjs}'] }) },
});
