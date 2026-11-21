import { describe, it, expect } from 'vitest';
import { percentile, trackRecord, trackRecordsByModel, type RunEffort } from './effort.js';

let clock = 0;
const run = (over: Partial<RunEffort> = {}): RunEffort => ({
  runId: `run-${clock}`,
  ownerId: 'user-1',
  agentSlug: 'research',
  procedureId: 'research',
  procedureVersion: '2',
  modelKey: 'tabby',
  modelLabel: 'Tabbyapi-Production',
  outcome: 'ok',
  rounds: 4,
  toolCalls: 6,
  totalTokens: 10_000,
  childRuns: 0,
  longestReply: 900,
  cappedAt: 0,
  steps: 20,
  wallClockMs: 60_000,
  ask: 'what is new?',
  limits: {},
  finishedAt: new Date(Date.UTC(2026, 8, 17, 0, 0, clock++)).toISOString(),
  ...over,
});

describe('the 90th percentile', () => {
  it('takes the value nine in ten runs stay at or under', () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(percentile([7, 1, 3], 0.9)).toBe(7);
    expect(percentile([], 0.9)).toBe(0);
  });
});

describe("a model's track record on a procedure", () => {
  it('counts every run and the ones that succeeded', () => {
    const five = [run(), run(), run(), run(), run({ outcome: 'failed', rounds: 50 })];

    expect(trackRecord(five)).toMatchObject({ runs: 5, successes: 4 });
  });

  it('says what its successful runs usually needed, leaving out failures', () => {
    const history = [
      ...[2, 3, 3, 4, 5, 5, 6, 6, 7, 10].map((rounds) => run({ rounds, wallClockMs: rounds * 10_000 })),
      run({ outcome: 'exhausted', rounds: 400 }),
    ];

    expect(trackRecord(history)).toMatchObject({
      successes: 10,
      typical: { rounds: 7, toolCalls: 6, totalTokens: 10_000, wallClockMs: 70_000 },
    });
  });

  it('says what runs usually need from the first success', () => {
    expect(trackRecord([run({ rounds: 3 })])?.typical.rounds).toBe(3);
  });

  it('learns from the most recent fifty successes, so an old habit fades', () => {
    const old = Array.from({ length: 50 }, () => run({ rounds: 30 }));
    const recent = Array.from({ length: 50 }, () => run({ rounds: 3 }));

    expect(trackRecord([...old, ...recent])?.typical.rounds).toBe(3);
  });

  it('keeps a separate record for every model', () => {
    const records = trackRecordsByModel([run(), run({ modelKey: 'other', modelLabel: 'Other' }), run()]);

    expect(records.map((record) => [record.modelKey, record.runs])).toEqual([['tabby', 2], ['other', 1]]);
  });

  it('shows the longest reply that worked and the largest one cut off', () => {
    const records = [
      ...[800, 900, 4000].map((longestReply) => run({ longestReply })),
      run({ longestReply: 90_000, outcome: 'failed' }),
      run({ outcome: 'failed', longestReply: 0, cappedAt: 700 }),
    ];

    expect(trackRecord(records)).toMatchObject({ largestReply: 4000, cappedAt: 700 });
  });
});

describe('the track record is numbers only', () => {
  it('turns nothing it records into a limit or a reply ceiling', () => {
    const settled = Array.from({ length: 20 }, () => run({ longestReply: 500 }));

    const record = trackRecord(settled);

    expect(record).not.toHaveProperty('limits');
    expect(record).not.toHaveProperty('replyCeiling');
  });
});
