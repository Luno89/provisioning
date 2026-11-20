import { describe, expect, it } from 'vitest';
import { evidenceFrom, evidenceOf, recordOf, type MutationReport } from './mutation.js';

const report: MutationReport = {
  files: {
    'src/a.ts': {
      mutants: [
        { id: '1', status: 'Killed', coveredBy: ['t1', 't2'], killedBy: ['t1'] },
        { id: '2', status: 'Survived', coveredBy: ['t1'] },
        { id: '3', status: 'NoCoverage' },
        { id: '4', status: 'Timeout', coveredBy: ['t2'] },
        { id: '5', status: 'CompileError' },
      ],
    },
  },
  testFiles: {
    'src/a.test.ts': { tests: [{ id: 't1', name: 'adds' }] },
    'src/a.integration.test.ts': { tests: [{ id: 't2', name: 'adds on mongo' }] },
  },
};

const layerOf = (file: string) => (file.includes('.integration.') ? 'component' as const : 'unit' as const);

describe('evidence from a mutation run', () => {
  it('counts each covered mutant once for each layer whose tests covered it, caught when a test of that layer killed it', () => {
    expect(evidenceOf(report, layerOf)).toEqual([
      { layer: 'unit', caught: true },
      { layer: 'component', caught: false },
      { layer: 'unit', caught: false },
      { layer: 'component', caught: true },
    ]);
  });

  it('takes a mutant that ran into a timeout as caught, since its tests could not pass it, and leaves out what no test covers or what did not compile', () => {
    const only = evidenceOf({ files: { 'src/b.ts': { mutants: [{ id: '9', status: 'Timeout', coveredBy: ['t1'] }, { id: '8', status: 'NoCoverage' }, { id: '7', status: 'RuntimeError', coveredBy: ['t1'] }] } }, testFiles: report.testFiles }, layerOf);
    expect(only).toEqual([{ layer: 'unit', caught: true }]);
  });
});

describe('mutants in code that runs as a module loads', () => {
  it('counts a mutant no single test covers, which every test was run against, for each layer of the run\'s tests', () => {
    const loaded = evidenceOf({ files: { 'src/c.ts': { mutants: [{ id: '6', status: 'Killed', killedBy: ['t2'] }, { id: '5', status: 'Survived' }] } }, testFiles: report.testFiles }, layerOf);
    expect(loaded).toEqual([
      { layer: 'unit', caught: false },
      { layer: 'component', caught: true },
      { layer: 'unit', caught: false },
      { layer: 'component', caught: false },
    ]);
  });
});

describe('the evidence kept across runs', () => {
  it('keeps a run as its counts per layer, with its area, commit and day', () => {
    expect(recordOf([{ layer: 'unit', caught: true }, { layer: 'unit', caught: false }, { layer: 'component', caught: true }], 'provision', 'abc123', '2026-11-20T10:00:00.000Z')).toEqual({
      area: 'provision', commit: 'abc123', at: '2026-11-20T10:00:00.000Z', layers: { unit: { caught: 1, missed: 1 }, component: { caught: 1, missed: 0 } },
    });
  });

  it('gives back each kept run\'s evidence, aged by the days since it ran', () => {
    const kept = [{ area: 'provision', commit: 'abc123', at: '2026-11-10T00:00:00.000Z', layers: { unit: { caught: 1, missed: 2 } } }];
    expect(evidenceFrom(kept, Date.parse('2026-11-20T00:00:00.000Z'))).toEqual([
      { layer: 'unit', caught: true, age: 10 },
      { layer: 'unit', caught: false, age: 10 },
      { layer: 'unit', caught: false, age: 10 },
    ]);
  });
});
