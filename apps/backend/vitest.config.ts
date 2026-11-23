import { defineConfig } from 'vitest/config';
import { REPORTERS, tiers } from '../../tests/tiers/projects.js';
import { OPTIONAL_SETUPS } from './vitest.setups.js';

export default defineConfig({
  test: {
    reporters: REPORTERS,
    globals: true,
    environment: 'node',
    projects: tiers({
      include: ['src/**/*.test.ts', '../../tests/lib/*.test.ts', '../../tests/coupling/*.test.ts', '../../tests/copies/*.test.ts','../../tests/alignment/*.test.ts', '../../tests/tiers/*.test.ts'],
      component: { globalSetup: ['./vitest.global-setup.ts'], setupFiles: ['./vitest.setup.ts'] },
      container: { globalSetup: ['./vitest.global-setup.ts', './vitest.temporal-setup.ts'], optional: OPTIONAL_SETUPS, setupFiles: ['./vitest.setup.ts'] },
      integration: { globalSetup: ['./vitest.global-setup.ts', './vitest.temporal-setup.ts'], optional: OPTIONAL_SETUPS, setupFiles: ['./vitest.setup.ts'] },
    }),
  },
});
