import { describe, expect, it } from 'vitest';
import { memoryLedger, runOnce } from './migrations.js';

describe('a migration runs once', () => {
  it('runs the first time, records what it did, and is skipped from then on', async () => {
    const ledger = memoryLedger();
    let runs = 0;
    const work = async () => { runs += 1; return { moved: 3 }; };
    expect(await runOnce(ledger, 'tool-grants', '2026-10-21T00:00:00Z', work)).toEqual({ moved: 3 });
    expect(await runOnce(ledger, 'tool-grants', '2026-10-21T00:01:00Z', work)).toEqual({});
    expect(runs).toBe(1);
    expect(ledger.records).toEqual([{ name: 'tool-grants', at: '2026-10-21T00:00:00Z', result: { moved: 3 } }]);
  });

  it('refuses a migration without a proper name, and records nothing when the work fails', async () => {
    const ledger = memoryLedger();
    await expect(runOnce(ledger, 'Tool Grants', 'now', async () => ({}))).rejects.toThrow(/named in lowercase words/);
    await expect(runOnce(ledger, 'breaks', 'now', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(ledger.records).toEqual([]);
  });
});
