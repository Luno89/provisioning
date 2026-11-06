import { defineConfig } from 'vitest/config';
import { REPORTERS, tiers } from '../../tests/tiers/projects.js';

export default defineConfig({
  test: {
    reporters: REPORTERS,
    globals: true,
    environment: 'node',
    projects: tiers({
      include: ['src/**/*.test.ts', '../../tests/lib/*.test.ts', '../../tests/coupling/*.test.ts', '../../tests/alignment/*.test.ts', '../../tests/tiers/*.test.ts'],
      integration: { globalSetup: ['./vitest.global-setup.ts', './vitest.temporal-setup.ts'], setupFiles: ['./vitest.setup.ts'] },
    }),
  },
});
