import { describe, expect, it } from 'vitest';
import type { Ran, RanRange } from './collect.js';
import type { Graph, Unit } from './graph.js';
import { codebaseOf, DEPENDENCIES, layerOf, SHARING, versionsIn } from './v2.js';

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
    { from: 'store', site: site(STORE, 5), to: ['pkg:mongodb#Collection.insertOne'], through: 'dependency', path: ['mongodb', 'users', 'Collection.insertOne'] },
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

    const codebase = codebaseOf(graph, runs, { changed: [HELP] });

    expect(codebase.units.map((one) => one.id).sort()).toEqual(['help', 'save', 'store']);
    expect(codebase.links.map((link) => [link.id, link.kind])).toEqual([
      [`${SAVE}:2`, 'logic'],
      [`${SAVE}:3`, 'composition'],
      [`${SAVE}:4`, 'composition'],
      [`${STORE}:5`, 'dependency'],
    ]);
    expect(codebase.runs).toEqual([
      { test: 'apps/backend/src/projects/services/save.test.ts', layer: 'unit', units: ['help', 'save'], links: [`${SAVE}:2`, `${SAVE}:4`] },
      { test: 'apps/backend/src/projects/services/save.integration.test.ts', layer: 'component', units: ['save', 'store'], links: [`${SAVE}:3`, `${STORE}:5`] },
    ]);
    expect(codebase.changed).toEqual(['help']);
    expect(codebase.links.at(-1)).toEqual({ id: `${STORE}:5`, from: 'store', to: ['pkg:mongodb#Collection.insertOne'], kind: 'dependency', path: ['mongodb', 'users', 'Collection.insertOne'], realFrom: 'component' });
  });

  it('carries what has happened since each run: proofs of code changed since go stale, each run keeps the versions it ran, and history weighs the risk', () => {
    const SAVE_TEST = 'apps/backend/src/projects/services/save.test.ts';
    const runs: Ran[] = [{ testFile: SAVE_TEST, files: { [SAVE]: [ran(1, 'save')], [HELP]: [ran(1, 'help')], [STORE]: [ran(1, 'store')] } }];

    const codebase = codebaseOf(graph, runs, {
      changed: [],
      since: () => ({ files: [STORE], versions: { mongodb: '6.10.0' } }),
      versions: { mongodb: '6.12.0' },
      churn: { [SAVE]: 4 },
      failures: { [SAVE_TEST]: 2 },
    });

    expect(codebase.runs[0]).toMatchObject({ expired: ['store'], versions: { mongodb: '6.10.0' } });
    expect(codebase.versions).toEqual({ mongodb: '6.12.0' });
    expect(codebase.history).toEqual({ changes: { save: 4 }, failures: { help: 2, save: 2, store: 2 } });
  });

  it('weighs a sibling\'s proof mostly by sharing its client and connection, as one working call shows the rest can work at the same version', () => {
    expect(SHARING.service).toBeGreaterThan(SHARING.resource + SHARING.operation);
  });

  it('reads each dependency\'s installed version from the lockfile, leaving out Node\'s own modules and what is not installed', () => {
    const lock = JSON.stringify({ packages: { 'node_modules/mongodb': { version: '6.12.0' }, 'node_modules/@temporalio/client': { version: '1.13.1' }, 'node_modules/yaml': { version: '2.9.0' } } });

    expect(versionsIn(lock, ['mongodb', '@temporalio/client', 'node:child_process', 'minio'])).toEqual({ mongodb: '6.12.0', '@temporalio/client': '1.13.1' });
  });

  it('gives two calls at the same spot of a line ids of their own', () => {
    const twice: Graph = { ...graph, edges: [
      { from: 'save', site: site(SAVE, 2), to: ['help'], through: 'call' },
      { from: 'save', site: site(SAVE, 2), to: ['store'], through: 'call' },
    ] };

    expect(codebaseOf(twice, [], { changed: [] }).links.map((link) => link.id)).toEqual([`${SAVE}:2:5`, `${SAVE}:2:5#2`]);
  });

  it('names the outside services Koala depends on and the lowest layer each is real at, and leaves pure libraries out', () => {
    expect(DEPENDENCIES.mongodb).toBe('component');
    expect(DEPENDENCIES['@temporalio/client']).toBe('component');
    expect(DEPENDENCIES.minio).toBe('container');
    expect(DEPENDENCIES.yaml).toBeUndefined();
  });
});
