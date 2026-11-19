import { fileURLToPath } from 'node:url';
import type { TestProjectInlineConfiguration } from 'vitest/config';
import type { PluginOption } from 'vite';

const here = (file: string): string => fileURLToPath(new URL(file, import.meta.url));

export const INTEGRATION = '**/*.integration.test.{ts,tsx,mjs}';
export const ONE_REAL = '**/*.real-*.test.{ts,tsx,mjs}';
export const REPORTERS = ['default', here('./failure-reporter.ts'), here('./timing-reporter.ts'), here('./status-reporter.ts')];
const UNIT_GUARD = here('./unit-guard.ts');
export const STATUS_SETUP = here('./status-setup.ts');
const OWN_HOME = here('./home.ts');
const COUPLING = here('../coupling/vitest-setup.ts');
const WORLD = here('../../packages/provision/testing/world-setup.ts');
const UNIT_WORLD = here('../../packages/provision/testing/unit-world-setup.ts');

export interface Setup { globalSetup: string; setupFiles?: string[] }

export const SETUPS_WANTED = 'KOALA_SETUPS';

export function wantedSetups(optional: Readonly<Record<string, Setup>>, wanted: string | undefined): Setup[] {
  if (wanted === undefined) return Object.values(optional);
  const names = wanted.split(',').filter(Boolean);
  const unknown = names.filter((name) => !(name in optional));
  if (unknown.length > 0) throw new Error(`${SETUPS_WANTED} names ${unknown.join(', ')}, which this workspace does not set up; it sets up ${Object.keys(optional).join(', ') || 'nothing optional'}`);
  return names.map((name) => optional[name]!);
}

export interface Tiers {
  include: string[];
  exclude?: string[];
  setupFiles?: string[];
  unit?: { setupFiles?: string[] };
  integration?: { setupFiles?: string[]; globalSetup?: string[]; optional?: Record<string, Setup>; env?: Record<string, string>; environment?: string; plugins?: PluginOption[] };
}

export function tiers(options: Tiers): TestProjectInlineConfiguration[] {
  const exclude = ['**/node_modules/**', ...(options.exclude ?? [])];
  const setup = options.setupFiles ?? [];
  const optional = wantedSetups(options.integration?.optional ?? {}, process.env[SETUPS_WANTED]);
  const integration = options.include.flatMap((pattern) => [pattern.replace(/\*\.test\.([^/]+)$/, '*.integration.test.$1'), pattern.replace(/\*\.test\.([^/]+)$/, '*.real-*.test.$1')]);
  return [
    {
      extends: true,
      test: { name: 'unit', testTimeout: 0, hookTimeout: 0, globalSetup: [UNIT_WORLD], include: options.include, exclude: [...exclude, INTEGRATION, ONE_REAL, ...integration], setupFiles: [OWN_HOME, STATUS_SETUP, UNIT_GUARD, ...setup, ...(options.unit?.setupFiles ?? []), COUPLING], expect: { requireAssertions: true } },
    },
    {
      extends: true,
      ...(options.integration?.plugins ? { plugins: options.integration.plugins } : {}),
      test: {
        name: 'integration',
        testTimeout: 0,
        hookTimeout: 0,
        include: integration,
        exclude,
        expect: { requireAssertions: true },
        globalSetup: [WORLD, ...(options.integration?.globalSetup ?? []), ...optional.map((setup) => setup.globalSetup)],
        ...(options.integration?.env ? { env: options.integration.env } : {}),
        ...(options.integration?.environment ? { environment: options.integration.environment } : {}),
        setupFiles: [OWN_HOME, STATUS_SETUP, ...setup, ...(options.integration?.setupFiles ?? []), ...optional.flatMap((one) => one.setupFiles ?? []), COUPLING],
      },
    },
  ];
}
