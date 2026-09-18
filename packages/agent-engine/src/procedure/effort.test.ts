import { describe, it, expect } from 'vitest';
import { LIMITS_ARE_ADVISORY, limitsFor, percentile, replyCeilingFor, replyCeilingFrom, trackRecord, trackRecordsByModel, type RunEffort } from './effort.js';

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
  it('sets no limits until it has finished the procedure successfully five times', () => {
    const four = [run(), run(), run(), run(), run({ outcome: 'failed', rounds: 50 })];

    expect(trackRecord(four)).toMatchObject({ runs: 5, successes: 4, limits: undefined });
  });

  it('gives 40% more than what its successful runs typically needed, leaving out failures', () => {
    const history = [
      ...[2, 3, 3, 4, 5, 5, 6, 6, 7, 10].map((rounds) => run({ rounds, wallClockMs: rounds * 10_000 })),
      run({ outcome: 'exhausted', rounds: 400 }),
    ];

    expect(trackRecord(history)).toMatchObject({
      successes: 10,
      typical: { rounds: 7, toolCalls: 6, wallClockMs: 70_000 },
      limits: { maxRounds: 10, maxToolCalls: 9, maxTokens: 14_000, maxWallClockMs: 98_000 },
    });
  });

  it('never limits something the procedure has never needed, rather than forbidding it outright', () => {
    const history = Array.from({ length: 5 }, () => run({ childRuns: 0 }));

    expect(trackRecord(history)?.limits).not.toHaveProperty('maxChildRuns');
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

  it('works out what a run usually needs, so it can be shown even though nothing is held to it', () => {
    const record = trackRecord(Array.from({ length: 5 }, () => run()));

    expect(record?.limits).toMatchObject({ maxRounds: 6, maxToolCalls: 9 });
    expect(limitsFor(undefined, {})).toEqual({});
  });
});

describe('how much room a reply should get', () => {
  it('has no ceiling to offer until the model has a track record', () => {
    const record = trackRecord([run(), run(), run(), run()]);

    expect(record?.successes).toBe(4);
    expect(record?.replyCeiling).toBeUndefined();
  });

  it('gives the largest reply it has seen work, plus headroom, once there are enough successes', () => {
    const records = [800, 900, 1000, 1100, 4000].map((longestReply) => run({ longestReply }));

    const record = trackRecord(records);

    expect(record?.largestReply).toBe(4000);
    expect(record?.replyCeiling).toBe(Math.ceil(4000 * 1.4));
  });

  it('ignores what the runs that failed needed', () => {
    const records = [
      ...[500, 500, 500, 500, 500].map((longestReply) => run({ longestReply })),
      run({ longestReply: 90_000, outcome: 'failed' }),
    ];

    expect(trackRecord(records)?.replyCeiling).toBe(700);
  });

  it('offers no ceiling when nothing ever reported a reply size', () => {
    const records = [0, 0, 0, 0, 0].map((longestReply) => run({ longestReply }));

    expect(trackRecord(records)?.replyCeiling).toBeUndefined();
  });
});

describe('keeping one persona\'s replies apart from another\'s on the same procedure', () => {
  const runs = [
    ...Array.from({ length: 5 }, () => run({ agentSlug: 'koala', longestReply: 60 })),
    ...Array.from({ length: 5 }, () => run({ agentSlug: 'agent-builder', longestReply: 5000 })),
  ];

  it('sizes each persona from its own replies', () => {
    expect(replyCeilingFrom(runs, 'koala')).toBe(84);
    expect(replyCeilingFrom(runs, 'agent-builder')).toBe(7000);
  });

  it('offers nothing for a persona that has not run it enough', () => {
    expect(replyCeilingFrom(runs, 'research')).toBeUndefined();
    expect(replyCeilingFrom([...runs, run({ agentSlug: 'research', longestReply: 900 })], 'research')).toBeUndefined();
  });
});

describe('a reply the cap cut off says the ceiling was too low, not that the run needed less', () => {
  const five = (over: Partial<RunEffort> = {}) => Array.from({ length: 5 }, () => run({ agentSlug: 'agent-builder', longestReply: 500, ...over }));

  it('doubles past the cap that truncated, rather than learning from the successes alone', () => {
    const settled = five();
    expect(replyCeilingFrom(settled, 'agent-builder')).toBe(700);

    const truncated = [...settled, run({ agentSlug: 'agent-builder', outcome: 'failed', longestReply: 0, cappedAt: 700 })];
    expect(replyCeilingFrom(truncated, 'agent-builder')).toBe(1400);
  });

  it('keeps the larger of what succeeded and what was cut off', () => {
    const records = [
      ...five({ longestReply: 5_000 }),
      run({ agentSlug: 'agent-builder', outcome: 'failed', longestReply: 0, cappedAt: 900 }),
    ];

    expect(replyCeilingFrom(records, 'agent-builder')).toBe(7_000);
  });

  it('stays wide open while the persona has no track record, whatever was cut off', () => {
    const records = [run({ agentSlug: 'agent-builder', outcome: 'failed', longestReply: 0, cappedAt: 700 })];

    expect(replyCeilingFrom(records, 'agent-builder')).toBeUndefined();
  });

  it('climbs again when the raised ceiling is cut off too', () => {
    const records = [
      ...five(),
      run({ agentSlug: 'agent-builder', outcome: 'failed', cappedAt: 700 }),
      run({ agentSlug: 'agent-builder', outcome: 'failed', cappedAt: 1400 }),
    ];

    expect(replyCeilingFrom(records, 'agent-builder')).toBe(2800);
  });
});

describe('none of it is enforced yet', () => {
  it('is set that way on purpose, so a limit learned from easy asks cannot cut off a harder one', () => {
    expect(LIMITS_ARE_ADVISORY).toBe(true);
  });

  it('holds a run only to what its own procedure asked for, never to what was learned', () => {
    const settled = Array.from({ length: 5 }, () => run());

    expect(trackRecord(settled)?.limits).toMatchObject({ maxRounds: 6 });
    expect(limitsFor(trackRecord(settled), {})).toEqual({});
    expect(limitsFor(trackRecord(settled), { maxRounds: 2 })).toEqual({ maxRounds: 2 });
  });

  it('gives a reply the window\'s room however much the track record says it usually needs', () => {
    const settled = Array.from({ length: 5 }, () => run({ agentSlug: 'agent-builder', longestReply: 500 }));

    expect(replyCeilingFrom(settled, 'agent-builder')).toBe(700);
    expect(replyCeilingFor(settled, 'agent-builder')).toBeUndefined();
  });
});
