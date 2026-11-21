import { defineConfig } from 'vitest/config';
import { tiers } from '../../tests/tiers/projects.js';

const [, integration] = tiers({ include: [], integration: { globalSetup: ['./vitest.global-setup.ts', './vitest.temporal-setup.ts'], setupFiles: ['./vitest.setup.ts'] } });

export const mutationTestsOf = (name: string, include: string[]) => defineConfig({
  test: { ...integration!.test, name, globals: true, environment: 'node', include },
});
