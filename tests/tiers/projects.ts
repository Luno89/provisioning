import { fileURLToPath } from 'node:url';
import type { TestProjectInlineConfiguration } from 'vitest/config';
import type { PluginOption } from 'vite';

const here = (file: string): string => fileURLToPath(new URL(file, import.meta.url));

export const INTEGRATION = '**/*.integration.test.{ts,tsx,mjs}';
export const COMPONENT = '**/*.component.test.{ts,tsx,mjs}';
export const CONTRACT = '**/*.contract.test.{ts,tsx,mjs}';
export const CONTAINER = '**/*.container.test.{ts,tsx,mjs}';
export const ONE_REAL = '**/*.real-*.test.{ts,tsx,mjs}';
export const REPORTERS = ['default', here('./failure-reporter.ts'), here('./timing-reporter.ts'), here('./status-reporter.ts')];
const UNIT_GUARD = here('./unit-guard.ts');
const COMPONENT_GUARD = here('./component-guard.ts');
const CONTRACT_GUARD = here('./contract-guard.ts');
const CONTAINER_GUARD = here('./container-guard.ts');
export const STATUS_SETUP = here('./status-setup.ts');
const OWN_HOME = here('./home.ts');
export const OWN_PROCESSES = here('./own-processes.ts');
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

export interface LayerOptions { setupFiles?: string[]; globalSetup?: string[]; optional?: Record<string, Setup>; env?: Record<string, string>; environment?: string; plugins?: PluginOption[] }

export interface Tiers {
  include: string[];
  exclude?: string[];
  setupFiles?: string[];
  unit?: { setupFiles?: string[] };
  component?: LayerOptions;
  contract?: LayerOptions;
  container?: LayerOptions;
  integration?: LayerOptions;
}

const named = (include: string[], kind: string): string[] => include.map((pattern) => pattern.replace(/\*\.test\.([^/]+)$/, `*.${kind}.test.$1`));

export function tiers(options: Tiers): TestProjectInlineConfiguration[] {
  const exclude = ['**/node_modules/**', ...(options.exclude ?? [])];
  const setup = options.setupFiles ?? [];
  const layer = (name: string, include: string[], layerOptions: LayerOptions | undefined, guard: string | undefined): TestProjectInlineConfiguration => {
    const optional = wantedSetups(layerOptions?.optional ?? {}, process.env[SETUPS_WANTED]);
    return {
      extends: true,
      ...(layerOptions?.plugins ? { plugins: layerOptions.plugins } : {}),
      test: {
        name,
        testTimeout: 0,
        hookTimeout: 0,
        include,
        exclude,
        expect: { requireAssertions: true },
        globalSetup: [WORLD, ...(layerOptions?.globalSetup ?? []), ...optional.map((one) => one.globalSetup)],
        ...(layerOptions?.env ? { env: layerOptions.env } : {}),
        ...(layerOptions?.environment ? { environment: layerOptions.environment } : {}),
        setupFiles: [OWN_PROCESSES, OWN_HOME, STATUS_SETUP, ...(guard ? [guard] : []), ...setup, ...(layerOptions?.setupFiles ?? []), ...optional.flatMap((one) => one.setupFiles ?? []), COUPLING],
      },
    };
  };
  const integration = [...named(options.include, 'integration'), ...named(options.include, 'real-*')];
  return [
    {
      extends: true,
      test: { name: 'unit', testTimeout: 0, hookTimeout: 0, globalSetup: [UNIT_WORLD], include: options.include, exclude: [...exclude, INTEGRATION, ONE_REAL, COMPONENT, CONTRACT, CONTAINER, ...integration], setupFiles: [OWN_HOME, STATUS_SETUP, UNIT_GUARD, ...setup, ...(options.unit?.setupFiles ?? []), COUPLING], expect: { requireAssertions: true } },
    },
    layer('component', named(options.include, 'component'), options.component, COMPONENT_GUARD),
    layer('contract', named(options.include, 'contract'), options.contract ?? options.component, CONTRACT_GUARD),
    layer('container', named(options.include, 'container'), options.container, CONTAINER_GUARD),
    layer('integration', integration, options.integration, undefined),
  ];
}
