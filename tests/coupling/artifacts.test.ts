import { describe, expect, it } from 'vitest';
import { judgedGather, type Gathered } from './artifacts.js';

const gathered: Gathered = { artifact: 'in-process', source: 'abc', commit: '698bc7368c21', at: '2026-11-23T12:31:00.000Z', workspaces: ['backend'], complete: true, timings: {} };

describe('which gathered runs the coupler judges', () => {
  it('refuses runs whose gather left no record, so a gather that stopped part way never leaves Koala judged as untested', () => {
    expect(() => judgedGather('in-process', { runs: true, gathered: undefined })).toThrow(/in-process.*no record of their gather/);
  });

  it('refuses a record of a gather whose runs are gone', () => {
    expect(() => judgedGather('live', { runs: false, gathered: { ...gathered, artifact: 'live' } })).toThrow(/live.*no runs/);
  });

  it('judges the runs of a recorded gather, and nothing for an artifact never gathered', () => {
    expect(judgedGather('in-process', { runs: true, gathered })).toBe(gathered);
    expect(judgedGather('live', { runs: false, gathered: undefined })).toBeUndefined();
  });
});
