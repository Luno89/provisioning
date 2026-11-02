import { fileURLToPath } from 'node:url';
import type { TestProjectInlineConfiguration } from 'vitest/config';

const here = (file: string): string => fileURLToPath(new URL(file, import.meta.url));

export const INTEGRATION = '**/*.integration.test.{ts,tsx,mjs}';
const UNIT_GUARD = here('./unit-guard.ts');
const COUPLING = here('../coupling/vitest-setup.ts');

export interface Tiers {
  include: string[];
  exclude?: string[];
  setupFiles?: string[];
  integration?: { setupFiles?: string[]; globalSetup?: string[] };
}

export function tiers(options: Tiers): TestProjectInlineConfiguration[] {
  const exclude = ['**/node_modules/**', ...(options.exclude ?? [])];
  const setup = options.setupFiles ?? [];
  const integration = options.include.map((pattern) => pattern.replace(/\*\.test\.([^/]+)$/, '*.integration.test.$1'));
  return [
    {
      extends: true,
      test: { name: 'unit', include: options.include, exclude: [...exclude, INTEGRATION, ...integration], setupFiles: [UNIT_GUARD, ...setup, COUPLING] },
    },
    {
      extends: true,
      test: {
        name: 'integration',
        include: integration,
        exclude,
        globalSetup: options.integration?.globalSetup ?? [],
        setupFiles: [...setup, ...(options.integration?.setupFiles ?? []), COUPLING],
      },
    },
  ];
}
