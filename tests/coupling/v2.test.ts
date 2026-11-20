import { describe, expect, it } from 'vitest';
import type { Ran, RanRange } from './collect.js';
import type { Graph, Unit } from './graph.js';
import { codebaseOf, layerOf } from './v2.js';

const unit = (id: string, file: string, name: string, extra: Partial<Unit> = {}): Unit => ({ id, file, name, line: 1, column: 1, start: 0, end: 0, inTest: false, ...extra });
const site = (file: string, line: number) => ({ file, line, column: 5, start: 0, end: 0 });
const ran = (count: number, fn: string): RanRange => ({ start: { line: 1, column: 1 }, end: { line: 10, column: 80 }, count, fn });

const SAVE = 'apps/backend/src/projects/services/save.ts';
const HELP = 'apps/backend/src/projects/lib/help.ts';
const STORE = 'apps/backend/src/platform/lib/store.ts';
const FAKE = 'apps/backend/src/platform/testing/fake-store.ts';

const graph: Graph = {
  units: {
    save: unit('save', SAVE, 'save'),
    help: unit('help', HELP, 'help'),
    store: unit('store', STORE, 'store'),
    fake: unit('fake', FAKE, 'fake', { inTest: true }),
    quiet: unit('quiet', HELP, 'quiet', { noBehaviour: true }),
    module: unit('module', HELP, '(module)'),
  },
  edges: [
    { from: 'save', site: site(SAVE, 2), to: ['help'], through: 'call' },
    { from: 'save', site: site(SAVE, 3), to: ['store', 'fake'], through: 'interface' },
    { from: 'save', site: site(SAVE, 4), to: ['help'], through: 'temporal' },
  ],
  unresolved: [], unmatched: [], records: [],
};

describe('Koala\'s code as the coupler sees it', () => {
  it('names each test file\'s layer: unit, the test run\'s own real neighbours, and the live suites on the whole of Koala', () => {
    expect(layerOf('apps/backend/src/projects/lib/help.test.ts')).toBe('unit');
    expect(layerOf('apps/backend/src/projects/services/save.integration.test.ts')).toBe('component');
    expect(layerOf('tests/v1-live.ts')).toBe('vm');
  });

  it('keeps only code with behaviour, sorts each call into logic or composition, and says which test proved which call for real', () => {
    const runs: Ran[] = [
      { testFile: 'apps/backend/src/projects/services/save.test.ts', files: { [SAVE]: [ran(1, 'save')], [HELP]: [ran(1, 'help')], [FAKE]: [ran(1, 'fake')], [STORE]: [ran(0, 'store')] } },
      { testFile: 'apps/backend/src/projects/services/save.integration.test.ts', files: { [SAVE]: [ran(1, 'save')], [STORE]: [ran(1, 'store')] } },
    ];

    const codebase = codebaseOf(graph, runs, [HELP]);

    expect(codebase.units.map((one) => one.id).sort()).toEqual(['help', 'save', 'store']);
    expect(codebase.links.map((link) => [link.id, link.kind])).toEqual([
      [`${SAVE}:2`, 'logic'],
      [`${SAVE}:3`, 'composition'],
      [`${SAVE}:4`, 'composition'],
    ]);
    expect(codebase.runs).toEqual([
      { test: 'apps/backend/src/projects/services/save.test.ts', layer: 'unit', units: ['help', 'save'], links: [`${SAVE}:2`, `${SAVE}:4`] },
      { test: 'apps/backend/src/projects/services/save.integration.test.ts', layer: 'component', units: ['save', 'store'], links: [`${SAVE}:3`] },
    ]);
    expect(codebase.changed).toEqual(['help']);
  });
});
