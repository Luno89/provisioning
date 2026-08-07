import { describe, it, expect } from 'vitest';
import {
  expandAxes,
  summariseResults,
  overclaimed,
  validateExperiment,
  plannedRuns,
  experimentTasks,
  summariseExperiment,
  latestResults,
  summariseRuns,
  priorExecutions,
  buildTaskMatrix,
  discriminatingTasks,
  LEGACY_TASK_ID,
  MAX_VARIANTS,
  MAX_TOTAL_RUNS,
  MAX_TASK_FILES,
  MAX_TASK_FILE_CHARS,
  type VariantResult,
} from './experiments.js';

const result = (over: Partial<VariantResult> = {}): VariantResult => ({
  label: 'think=false',
  succeeded: true,
  verified: true,
  verifyExitCode: 0,
  verifyOutput: 'PASS',
  steps: 5,
  tokensUsed: 1000,
  durationMs: 30_000,
  summary: 'done',
  transcript: [],
  ...over,
});

/** A run of a named task by a named variant, passing or not. */
const run = (taskId: string, label: string, verified: boolean, over: Partial<VariantResult> = {}) =>
  result({ taskId, label, verified, succeeded: verified, ...over });

const task = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: id, prompt: `do ${id}`, verifyCommand: 'node t.js', ...over,
});

describe('expandAxes', () => {
  it('turns one axis into one variant per value', () => {
    expect(expandAxes({ think: [false, true] })).toEqual([
      { label: 'think=false', overrides: { think: false } },
      { label: 'think=true', overrides: { think: true } },
    ]);
  });

  it('crosses two axes, so each combination is its own variant', () => {
    const variants = expandAxes({ think: [false, true], maxSteps: [8, 16] });
    expect(variants).toHaveLength(4);
    expect(variants.map((v) => v.label)).toContain('think=true maxSteps=16');
  });

  it('returns the whole cross product, leaving the ceiling to validation', () => {
    // It used to slice to MAX_VARIANTS here, which meant a three-axis design silently ran a
    // subset — the experiment on screen was not the experiment that executed, and which
    // combinations survived depended on key order. Over-cap is now a rejection, not an edit.
    const variants = expandAxes({ a: [1, 2, 3], b: [1, 2, 3], c: [1, 2, 3] });
    expect(variants).toHaveLength(27);
    expect(validateExperiment({
      name: 'n', task: 't', verifyCommand: 'v', variants, repeats: 1,
    })).toMatch(new RegExp(`limit is ${MAX_VARIANTS}`));
  });

  it('ignores empty axes instead of producing a variant that changes nothing', () => {
    expect(expandAxes({ think: [], maxSteps: [4] })).toEqual([
      { label: 'maxSteps=4', overrides: { maxSteps: 4 } },
    ]);
    expect(expandAxes({})).toEqual([]);
  });
});

describe('summariseResults', () => {
  it('counts verified and claimed separately', () => {
    // The whole point of the verify command: an agent's self-report is the least reliable number
    // in the run.
    const [summary] = summariseResults([
      result({ succeeded: true, verified: true }),
      result({ succeeded: true, verified: false }),
    ]);
    expect(summary!.runs).toBe(2);
    expect(summary!.claimed).toBe(2);
    expect(summary!.verified).toBe(1);
  });

  it('uses the median, so one run hitting the step ceiling cannot reverse the winner', () => {
    const [summary] = summariseResults([
      result({ tokensUsed: 100 }),
      result({ tokensUsed: 200 }),
      result({ tokensUsed: 99_000 }),
    ]);
    expect(summary!.medianTokens).toBe(200);
  });

  it('leaves runs that never completed out of the medians', () => {
    // A run that errored recorded zeros because nothing ran. Counted as a measurement it makes the
    // variant look dramatically cheaper for having failed to start — the opposite of the truth.
    const [summary] = summariseResults([
      result({ steps: 10, tokensUsed: 5000 }),
      result({ steps: 12, tokensUsed: 6000 }),
      result({ steps: 0, tokensUsed: 0, durationMs: 900, error: 'Model call failed (502)' }),
    ]);
    expect(summary!.errored).toBe(1);
    expect(summary!.runs).toBe(3);
    expect(summary!.medianSteps).toBe(11);
    expect(summary!.medianTokens).toBe(5500);
  });

  it('reports zero rather than a fabricated median when every run errored', () => {
    const [summary] = summariseResults([result({ steps: 0, error: 'no endpoint' })]);
    expect(summary!.errored).toBe(1);
    expect(summary!.medianSteps).toBe(0);
  });

  it('groups by variant label', () => {
    const summaries = summariseResults([result({ label: 'a' }), result({ label: 'b' }), result({ label: 'a' })]);
    expect(summaries.map((s) => [s.label, s.runs])).toEqual([['a', 2], ['b', 1]]);
  });
});

describe('experimentTasks', () => {
  it('reads a suite as written', () => {
    const tasks = [task('t1'), task('t2')];
    expect(experimentTasks({ tasks, language: 'node' })).toEqual(tasks);
  });

  it('presents a pre-suite experiment as a one-task suite', () => {
    // These are real measurements someone paid GPU time for. A schema change is a poor reason to
    // make an old result unreadable, so exactly one place knows about the old shape.
    const tasks = experimentTasks({ task: 'write fib', verifyCommand: 'node t.js', language: 'go' });
    expect(tasks).toEqual([
      { id: LEGACY_TASK_ID, name: 'Task', prompt: 'write fib', verifyCommand: 'node t.js', language: 'go' },
    ]);
  });

  it('groups results that predate task ids under that same synthetic task', () => {
    // Otherwise an old experiment renders as an empty matrix beside a row of orphaned runs.
    const legacy = experimentTasks({ task: 'write fib', verifyCommand: 'node t.js', language: 'node' });
    const [row] = buildTaskMatrix(
      [result({ verified: true }), result({ verified: false })],
      legacy,
      [{ label: 'think=false' }],
    );
    expect(row!.cells[0]!.runs).toBe(2);
    expect(row!.cells[0]!.verified).toBe(1);
  });
});

describe('buildTaskMatrix', () => {
  const variants = [{ label: 'a' }, { label: 'b' }];
  const tasks = [task('t1'), task('t2')];

  it('scores every variant on every task', () => {
    const matrix = buildTaskMatrix([
      run('t1', 'a', true), run('t1', 'b', false),
      run('t2', 'a', false), run('t2', 'b', true),
    ], tasks, variants);

    expect(matrix.map((r) => r.cells.map((c) => `${c.verified}/${c.runs}`))).toEqual([
      ['1/1', '0/1'],
      ['0/1', '1/1'],
    ]);
  });

  it('is the reason a suite exists: two variants tie overall and disagree on every task', () => {
    // The finding no aggregate can show. Both variants sit at 1/2, and reporting only that would
    // call the setting a dead heat when it in fact changed which tasks succeed.
    const results = [
      run('t1', 'a', true), run('t1', 'b', false),
      run('t2', 'a', false), run('t2', 'b', true),
    ];
    const overall = summariseResults(results);
    expect(overall.map((s) => s.verified)).toEqual([1, 1]);

    const matrix = buildTaskMatrix(results, tasks, variants);
    expect(matrix.every((r) => r.uninformative)).toBe(false);
    expect(discriminatingTasks(matrix).map((t) => t.taskId)).toEqual(['t1', 't2']);
  });

  it('marks a task nothing distinguishes, which cost sandboxes and bought no evidence', () => {
    const matrix = buildTaskMatrix([run('t1', 'a', true), run('t1', 'b', true)], [task('t1')], variants);
    expect(matrix[0]!.uninformative).toBe(true);
    expect(matrix[0]!.allFailed).toBe(false);
    expect(discriminatingTasks(matrix)).toEqual([]);
  });

  it('marks a task every variant failed, which is usually the task being broken', () => {
    const matrix = buildTaskMatrix([run('t1', 'a', false), run('t1', 'b', false)], [task('t1')], variants);
    expect(matrix[0]!.allFailed).toBe(true);
    expect(matrix[0]!.uninformative).toBe(true);
  });

  it('does not call a half-run task uninformative', () => {
    // Mid-run the second variant has no results yet. Treating its empty cell as agreement would
    // report a verdict on a task that has been measured once.
    const matrix = buildTaskMatrix([run('t1', 'a', true)], [task('t1')], variants);
    expect(matrix[0]!.uninformative).toBe(false);
    expect(matrix[0]!.cells[1]!.runs).toBe(0);
  });

  it('ranks tasks by how far apart they drove the variants', () => {
    const matrix = buildTaskMatrix([
      // t1 splits them completely, t2 only partly.
      run('t1', 'a', true), run('t1', 'a', true), run('t1', 'b', false), run('t1', 'b', false),
      run('t2', 'a', true), run('t2', 'a', true), run('t2', 'b', true), run('t2', 'b', false),
    ], tasks, variants);
    expect(discriminatingTasks(matrix)).toEqual([
      { taskId: 't1', spread: 1 },
      { taskId: 't2', spread: 0.5 },
    ]);
  });
});

describe('summariseExperiment', () => {
  const heavy = (): any => ({
    id: 'e1', ownerId: 'u1', name: 'suite', language: 'node',
    tasks: [{ id: 't1', name: 'fib', prompt: 'x'.repeat(8000), verifyCommand: 'node t.js', language: 'go' }],
    variants: [{ label: 'a', overrides: {} }],
    repeats: 1, status: 'complete',
    results: [{
      label: 'a', taskId: 't1', succeeded: true, verified: false, verifyExitCode: 1,
      steps: 24, tokensUsed: 42_000, durationMs: 1000,
      summary: 's'.repeat(4000),
      verifyOutput: 'v'.repeat(2000),
      transcript: ['ls', 'node t.js'],
      request: { systemPrompt: 'p'.repeat(2000), kickoff: 'go', tools: [], parameters: {}, overrides: {}, unsupported: [], loop: { maxSteps: 24, think: false, toolResultCap: 8000 } },
      trace: Array.from({ length: 24 }, (_, i) => ({
        step: i + 1, reasoning: 'r'.repeat(6000), toolCalls: [], toolResults: [], tokens: 100,
      })),
    }],
    createdAt: 'a', updatedAt: 'b',
  });

  it('drops the evidence and keeps the scores', () => {
    // One six-run suite of full records is on the order of a megabyte, and the list is polled every
    // five seconds against the whole archive.
    const summary = summariseExperiment(heavy());
    const [r] = summary.results;

    expect(r).toEqual({
      label: 'a', taskId: 't1', succeeded: true, verified: false, verifyExitCode: 1,
      steps: 24, tokensUsed: 42_000, durationMs: 1000,
    });
    expect(JSON.stringify(summary).length).toBeLessThan(1000);
  });

  it('keeps everything the matrix needs to render', () => {
    const summary = summariseExperiment(heavy());
    // Task identity for the rows, variants for the columns, and the numbers for the cells.
    expect(summary.tasks).toEqual([{ id: 't1', name: 'fib', language: 'go' }]);
    expect(summary.variants).toHaveLength(1);
    expect(summary.status).toBe('complete');
  });

  it('normalises a pre-suite record, so the client sees one task shape', () => {
    const legacy: any = {
      id: 'old', ownerId: 'u1', name: 'legacy', language: 'node',
      task: 'write fib', verifyCommand: 'node t.js',
      variants: [{ label: 'a', overrides: {} }], repeats: 1, status: 'complete',
      results: [], createdAt: 'a', updatedAt: 'b',
    };
    expect(summariseExperiment(legacy).tasks).toEqual([{ id: LEGACY_TASK_ID, name: 'Task', language: 'node' }]);
  });

  it('keeps that a run errored, since the medians and the count depend on it', () => {
    const withError: any = heavy();
    withError.results[0].error = 'x'.repeat(500);
    const [r] = summariseExperiment(withError).results;
    expect(r!.error).toHaveLength(200);
  });
});

describe('overclaimed', () => {
  it('finds runs the agent called a success that verification failed', () => {
    // This is the failure that silently corrupts everything downstream — a leaf marked succeeded
    // and moved to review on work that never happened.
    const flagged = overclaimed([
      result({ succeeded: true, verified: false, label: 'lying' }),
      result({ succeeded: true, verified: true }),
      result({ succeeded: false, verified: false }),
    ]);
    expect(flagged.map((r) => r.label)).toEqual(['lying']);
  });
});

describe('validateExperiment', () => {
  const valid = {
    name: 'thinking on/off',
    tasks: [task('t1'), task('t2')],
    variants: expandAxes({ think: [false, true] }),
    repeats: 1,
  };

  it('accepts a well-formed suite', () => {
    expect(validateExperiment(valid)).toBeNull();
  });

  it('still accepts a pre-suite experiment, so old records stay runnable', () => {
    expect(validateExperiment({
      name: 'legacy', task: 'write fib', verifyCommand: 'node t.js',
      variants: expandAxes({ think: [false, true] }), repeats: 1,
    })).toBeNull();
  });

  it('insists on a verify command per task, naming which one is missing', () => {
    const missing = validateExperiment({
      ...valid,
      tasks: [task('t1'), task('broken', { verifyCommand: '' })],
    });
    expect(missing).toMatch(/verify command/i);
    expect(missing).toMatch(/broken/);
  });

  it('insists on a prompt per task', () => {
    expect(validateExperiment({ ...valid, tasks: [task('t1', { prompt: '  ' })] })).toMatch(/prompt/i);
  });

  it('rejects an empty suite', () => {
    expect(validateExperiment({ ...valid, tasks: [] })).toMatch(/at least one task/i);
  });

  it('rejects the product, not just each dimension', () => {
    // Reached by three individually reasonable choices — a fifth task, a third variant, three
    // repeats — none of which is over its own limit.
    const message = validateExperiment({
      ...valid,
      tasks: Array.from({ length: 6 }, (_, i) => task(`t${i}`)),
      variants: expandAxes({ think: [false, true], maxSteps: [8, 16] }),
      repeats: 5,
    });
    expect(message).toMatch(new RegExp(`over the limit of ${MAX_TOTAL_RUNS}`));
    expect(message).toMatch(/120 sandboxes/);
  });

  it('rejects duplicate variant labels, which would make results unattributable', () => {
    expect(validateExperiment({
      ...valid,
      variants: [{ label: 'same', overrides: {} }, { label: 'same', overrides: { think: true } }],
    })).toMatch(/share a label/i);
  });

  it('rejects an unnamed experiment', () => {
    expect(validateExperiment({ ...valid, name: '' })).toBeTruthy();
  });

  it('bounds repeats, since each one is a real sandbox', () => {
    expect(validateExperiment({ ...valid, repeats: 99 })).toMatch(/Repeats/);
  });
});

describe('plannedRuns', () => {
  it('multiplies the suite in, since every task is run by every variant', () => {
    expect(plannedRuns({
      tasks: [task('t1'), task('t2'), task('t3')],
      variants: expandAxes({ think: [false, true] }),
      repeats: 3,
      language: 'node',
    })).toBe(18);
  });

  it('counts a pre-suite experiment as the one task it holds', () => {
    expect(plannedRuns({
      task: 'write fib', verifyCommand: 'node t.js', language: 'node',
      variants: expandAxes({ think: [false, true] }), repeats: 3,
    })).toBe(6);
  });
});

describe('run history', () => {
  const runOf = (id: string, verified: number, total: number, over: Record<string, unknown> = {}): any => ({
    id, startedAt: `2026-08-04T0${id.slice(-1)}:00:00Z`, status: 'complete',
    results: Array.from({ length: total }, (_, i) => result({ verified: i < verified })),
    ...over,
  });

  it('reads the LATEST execution as the current results', () => {
    // Running an experiment used to clear its results, which made a suite something you could only
    // ask once. The point of keeping it is asking again after a change.
    const e: any = { runs: [runOf('r1', 1, 3), runOf('r2', 3, 3)], results: [] };
    expect(latestResults(e).filter((r) => r.verified)).toHaveLength(3);
  });

  it('falls back to the pre-history field for records written before runs existed', () => {
    const e: any = { results: [result({ verified: true })] };
    expect(latestResults(e)).toHaveLength(1);
  });

  it('summarises every execution so two can be compared without their traces', () => {
    const e: any = { runs: [runOf('r1', 1, 3, { model: 'qwen3' }), runOf('r2', 3, 3, { model: 'qwen4' })] };
    expect(summariseRuns(e)).toEqual([
      // `attempted` sits beside `runs` rather than replacing it: an execution where half the runs
      // died is a different fact from one where they all ran, and one number cannot carry both.
      { id: 'r1', startedAt: '2026-08-04T01:00:00Z', status: 'complete', model: 'qwen3', verified: 1, runs: 3, attempted: 3, broken: 0 },
      { id: 'r2', startedAt: '2026-08-04T02:00:00Z', status: 'complete', model: 'qwen4', verified: 3, runs: 3, attempted: 3, broken: 0 },
    ]);
  });

  it('keeps history out of the list payload while keeping the comparison', () => {
    // The whole reason the list/detail split exists: a comparison must not cost every run's trace.
    const e: any = {
      id: 'e1', ownerId: 'u', name: 'n', language: 'node', variants: [], repeats: 1,
      status: 'complete', createdAt: 'a', updatedAt: 'b', tasks: [task('t1')],
      runs: [runOf('r1', 1, 3), runOf('r2', 3, 3)], results: [],
    };
    const summary = summariseExperiment(e);
    expect(summary.history.map((h) => `${h.verified}/${h.runs}`)).toEqual(['1/3', '3/3']);
    expect(JSON.stringify(summary)).not.toMatch(/"trace"/);
  });
});

describe('priorExecutions', () => {
  const base: any = {
    id: 'e1', ownerId: 'u', name: 'n', language: 'node', variants: [], repeats: 1,
    createdAt: '2026-08-04T09:00:00Z', updatedAt: '2026-08-04T10:00:00Z',
  };

  it('promotes pre-history results to execution one', () => {
    // Otherwise appending a new execution makes the older evidence invisible the first time an
    // experiment is re-run — losing the comparison re-running exists to produce.
    const [first, ...rest] = priorExecutions({ ...base, status: 'complete', results: [result()] });
    expect(rest).toEqual([]);
    expect(first!.id).toBe('r0');
    expect(first!.results).toHaveLength(1);
    expect(first!.status).toBe('complete');
    expect(first!.startedAt).toBe('2026-08-04T09:00:00Z');
  });

  it('records a failed record as a failed execution', () => {
    expect(priorExecutions({ ...base, status: 'failed', results: [result()] })[0]!.status).toBe('failed');
  });

  it('invents nothing for a record that never ran', () => {
    expect(priorExecutions({ ...base, status: 'draft', results: [] })).toEqual([]);
  });

  it('leaves an experiment that already has executions alone', () => {
    const runs: any = [{ id: 'rX', startedAt: 'a', status: 'complete', results: [] }];
    expect(priorExecutions({ ...base, status: 'complete', results: [result()], runs })).toBe(runs);
  });
});

describe('seed and solution', () => {
  const withFiles = (over: Record<string, unknown> = {}) => ({
    name: 'reader',
    task: 'x', verifyCommand: 'node t.js',
    variants: expandAxes({ think: [false, true] }),
    repeats: 1,
    tasks: [task('t1', over)],
  });

  it('accepts a task that seeds the world the agent wakes up in', () => {
    // The shape that was impossible to express: "read data.txt" needs data.txt to exist, and with
    // nowhere to put it the only move was having the verify command create its own input.
    expect(validateExperiment(withFiles({
      seed: [{ path: 'data.txt', content: 'hello' }],
      solution: [{ path: 'read.js', content: 'console.log(require("fs").readFileSync("data.txt","utf8"))' }],
    }))).toBeNull();
  });

  it('rejects a path that escapes the workspace', () => {
    // A message at creation, not an exception halfway through a run that already cost sandboxes.
    expect(validateExperiment(withFiles({ seed: [{ path: '../etc/passwd', content: 'x' }] })))
      .toMatch(/must be relative to \/work/);
    expect(validateExperiment(withFiles({ seed: [{ path: '/etc/passwd', content: 'x' }] })))
      .toMatch(/must be relative to \/work/);
  });

  it('rejects a seed file with no path', () => {
    expect(validateExperiment(withFiles({ seed: [{ path: '  ', content: 'x' }] })))
      .toMatch(/no path/);
  });

  it('bounds how much a suite can carry', () => {
    // A suite travels in one document and is exported as one file.
    expect(validateExperiment(withFiles({
      seed: Array.from({ length: MAX_TASK_FILES + 1 }, (_, i) => ({ path: `f${i}`, content: 'x' })),
    }))).toMatch(new RegExp(`more than ${MAX_TASK_FILES} seed files`));

    expect(validateExperiment(withFiles({
      solution: [{ path: 'big.js', content: 'x'.repeat(MAX_TASK_FILE_CHARS + 1) }],
    }))).toMatch(/longer than/);
  });

  it('is optional — a task that starts from nothing still validates', () => {
    expect(validateExperiment(withFiles())).toBeNull();
  });
});
