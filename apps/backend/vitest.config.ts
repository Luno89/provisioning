import { defineConfig } from 'vitest/config';
import { tiers } from '../../tests/tiers/projects.js';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    projects: tiers({
      include: ['src/**/*.test.ts', '../../tests/lib/*.test.ts', '../../tests/coupling/*.test.ts', '../../tests/tiers/*.test.ts'],
      integration: { globalSetup: ['./vitest.global-setup.ts'], setupFiles: ['./vitest.setup.ts'] },
    }),
  },
});
