/**
 * A/B experiments against the harness.
 *
 * ── WHY THE VERIFY COMMAND IS NOT OPTIONAL ──
 * An agent reports its own success, and that report is the least trustworthy number in the run. In
 * live testing a model summarised "ran node test.js — it passed" on a run where the file it had
 * written was in the wrong directory. So every experiment carries a command that is run in the
 * sandbox AFTER the agent finishes, and its exit code — not the agent's summary — decides whether
 * the variant worked. `succeeded` and `verified` are reported separately precisely so the gap
 * between them is visible; a variant that claims success and fails verification is the most
 * interesting result the harness can produce.
 *
 * ── WHY AN EXPERIMENT HOLDS A SET OF TASKS ──
 * It used to hold exactly one, and every conclusion it produced was therefore of the form "this
 * setting is better at writing fib" — which is not a claim anyone wants to act on. One task cannot
 * distinguish a genuinely better configuration from one that happens to suit a single prompt, and
 * with repeats alone the only way to add confidence was to run the SAME task again, which measures
 * variance and not generality.
 *
 * A suite changes what the numbers mean. The headline becomes a pass rate across tasks, and the
 * per-task breakdown is what carries the finding: a variant that wins on four tasks and loses on
 * one is a different result from a variant that wins on one and ties on four, and both used to
 * report as "better".
 *
 * Pure, so the shape of a comparison can be tested without a GPU.
 */
import type {
  Experiment,
  ExperimentOverrides,
  ExperimentStatus,
  ExperimentSummary,
  ExperimentTask,
  ExperimentVariant,
  ExperimentRun,
  TaskFile,
  ResultSummary,
  RunSummary,
  TaskSummary,
  VariantResult,
  WorkspaceLanguage,
} from '@koala/harness-types';
import { validateOverrides } from './tunables.js';
import { countOutcomes, attempted } from './run-outcome.js';
import type { OutcomeCounts } from '@koala/harness-types';

/**
 * Re-exported so the modules that already import these from here keep working.
 *
 * The definitions moved to `@koala/harness-types` because the Lab declares them too, and a wire
 * contract maintained in two places drifts silently — see that package's header for the two
 * occasions it did.
 */
export type {
  Experiment,
  ExperimentOverrides,
  ExperimentStatus,
  ExperimentSummary,
  ExperimentTask,
  ExperimentVariant,
  ExperimentRun,
  TaskFile,
  ResultSummary,
  RunSummary,
  TaskSummary,
  VariantResult,
};

/** Longest error kept in a list row. The untruncated text is on the detail record. */
const MAX_SUMMARY_ERROR = 200;

/**
 * Strips a record down to what the list renders.
 *
 * Normalises the pre-suite shape on the way through, so the client never sees two task layouts and
 * `tasksOf`-style branching disappears from the UI entirely.
 */
export function summariseExperiment(experiment: Experiment): ExperimentSummary {
  return {
    id: experiment.id,
    ownerId: experiment.ownerId,
    name: experiment.name,
    language: experiment.language,
    tasks: experimentTasks(experiment).map((t) => ({
      id: t.id,
      name: t.name,
      ...(t.language ? { language: t.language } : {}),
    })),
    variants: experiment.variants,
    repeats: experiment.repeats,
    status: experiment.status,
    history: summariseRuns(experiment),
    results: latestResults(experiment).map((r) => ({
      label: r.label,
      // Always resolved, never passed through optional. A pre-suite result carries no taskId, and
      // leaving the client to default it meant shipping the same constant to both sides under a
      // comment saying "must match the backend" — a rule nothing could check.
      taskId: taskIdOf(r),
      succeeded: r.succeeded,
      verified: r.verified,
      verifyExitCode: r.verifyExitCode,
      steps: r.steps,
      tokensUsed: r.tokensUsed,
      durationMs: r.durationMs,
      ...(r.toolsUsed ? { toolsUsed: r.toolsUsed } : {}),
      ...(r.usedDedicatedTool !== undefined ? { usedDedicatedTool: r.usedDedicatedTool } : {}),
      ...(r.error ? { error: r.error.slice(0, MAX_SUMMARY_ERROR) } : {}),
    })),
    progress: experiment.progress,
    error: experiment.error,
    createdAt: experiment.createdAt,
    updatedAt: experiment.updatedAt,
  };
}

/**
 * The results of the most recent execution.
 *
 * `runs` is canonical and `results` is the pre-history field, so this is the one place that knows
 * which era a record comes from. Deriving rather than storing both avoids keeping the latest run's
 * traces twice in a document that already has a 16MB ceiling.
 */
export function latestResults(
  experiment: Pick<Experiment, 'runs' | 'results'>,
): VariantResult[] {
  const last = experiment.runs?.[experiment.runs.length - 1];
  return last ? last.results : (experiment.results ?? []);
}

/**
 * The executions an experiment already has, with pre-history evidence promoted to the first.
 *
 * Records written before `runs[]` keep their results in the old field, which `latestResults` only
 * consults when there are no runs. Appending a new execution to such a record without this would
 * make the older evidence invisible the first time it was re-run — losing exactly the comparison
 * that re-running exists to produce.
 */
export function priorExecutions(experiment: Experiment): ExperimentRun[] {
  if (experiment.runs) return experiment.runs;
  if (!experiment.results?.length) return [];
  return [{
    id: 'r0',
    startedAt: experiment.createdAt,
    finishedAt: experiment.updatedAt,
    // Only a failed record is known to have failed; anything else that produced results finished.
    status: experiment.status === 'failed' ? 'failed' : 'complete',
    results: experiment.results,
  }];
}

/** The execution currently in flight, if any. */
export function currentRun(experiment: Pick<Experiment, 'runs'>): ExperimentRun | undefined {
  return experiment.runs?.[experiment.runs.length - 1];
}

/**
 * Every execution, compactly — enough to offer a comparison, none of the evidence.
 *
 * This is what makes "re-run it after the change" mean something: the list can show that a suite
 * scored 3/9 in the morning and 7/9 after a prompt was reworded, without shipping either run's
 * traces to draw the comparison.
 */
export function summariseRuns(experiment: Pick<Experiment, 'runs'>): RunSummary[] {
  return (experiment.runs ?? []).map((r) => ({
    id: r.id,
    startedAt: r.startedAt,
    ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}),
    status: r.status,
    ...(r.model ? { model: r.model } : {}),
    verified: r.results.filter((x) => x.verified).length,
    runs: r.results.length,
    attempted: attempted(r.results).length,
    broken: countOutcomes(r.results).broken,
  }));
}

/**
 * A full record with its pre-suite shape resolved.
 *
 * The detail route's counterpart to `summariseExperiment`. Both normalise, so the client sees one
 * task layout and one result shape whatever era a record comes from — which is what let the UI
 * stop carrying its own copy of `LEGACY_TASK_ID` under a comment saying "must match the backend".
 * A constant that must match and cannot be checked is a bug with a delay on it.
 */
export function normaliseExperiment(experiment: Experiment): Experiment {
  return {
    ...experiment,
    tasks: experimentTasks(experiment),
    // The latest execution's results, so existing readers see what they always did.
    results: latestResults(experiment).map((r) => ({ ...r, taskId: taskIdOf(r) })),
    ...(experiment.runs
      ? { runs: experiment.runs.map((run) => ({
          ...run,
          results: run.results.map((r) => ({ ...r, taskId: taskIdOf(r) })),
        })) }
      : {}),
  };
}

/** Ceilings. Each run is a real sandbox and real inference, so a typo should not cost an hour. */
export const MAX_VARIANTS = 6;
export const MAX_REPEATS = 5;
export const MAX_TASK_CHARS = 8000;
export const MAX_TASKS = 10;
/** Seed and solution ceilings. A suite travels in one document and is exported as one file. */
export const MAX_TASK_FILES = 10;
export const MAX_TASK_FILE_CHARS = 20_000;
/**
 * The ceiling that actually binds, because the others multiply.
 *
 * Six variants × five repeats × ten tasks is three hundred sandboxes and, at a couple of minutes
 * each, most of a day — reachable by three clicks that each look individually reasonable. This is
 * checked against the product rather than any single dimension.
 */
export const MAX_TOTAL_RUNS = 60;

/**
 * The suite, however the record spells it.
 *
 * Every read goes through here so that exactly one place knows about the pre-suite shape. Falling
 * back to a synthetic single task — rather than returning empty — is what keeps an old experiment's
 * results rendering in the same matrix as a new one's.
 */
export function experimentTasks(
  experiment: Pick<Experiment, 'tasks' | 'task' | 'verifyCommand' | 'language'>,
): ExperimentTask[] {
  if (experiment.tasks?.length) return experiment.tasks;
  if (!experiment.task?.trim()) return [];
  return [{
    id: LEGACY_TASK_ID,
    name: 'Task',
    prompt: experiment.task,
    verifyCommand: experiment.verifyCommand ?? '',
    ...(experiment.language ? { language: experiment.language } : {}),
  }];
}

/**
 * The task id given to results from before suites existed.
 *
 * Those results carry no `taskId` at all, so grouping them needs a name to group them UNDER — and
 * it has to be the same name `experimentTasks` invents, or an old experiment renders as a matrix
 * of empty cells beside a row of orphaned runs.
 */
export const LEGACY_TASK_ID = 'task';

/** The task a result belongs to, defaulting old records into the synthetic legacy task. */
export const taskIdOf = (result: VariantResult): string => result.taskId ?? LEGACY_TASK_ID;

/**
 * Expands axes into variants — `{think: [false, true]}` becomes two.
 *
 * Offered because the interesting questions are usually one axis at a time, and writing the cross
 * product by hand invites a variant that differs in two things at once, which cannot be attributed.
 *
 * Returns the WHOLE cross product, even when that exceeds MAX_VARIANTS. It used to slice, which
 * meant selecting three axes quietly dropped two of the eight combinations — the design you read
 * in the UI was not the design that ran, and which combinations survived depended on key order.
 * Enforcing the ceiling is `validateExperiment`'s job, where exceeding it becomes a message
 * instead of a silent edit.
 */
export function expandAxes(axes: Record<string, unknown[]>): ExperimentVariant[] {
  const keys = Object.keys(axes).filter((k) => Array.isArray(axes[k]) && axes[k]!.length);
  if (!keys.length) return [];

  let combos: Record<string, unknown>[] = [{}];
  for (const key of keys) {
    combos = combos.flatMap((combo) => axes[key]!.map((value) => ({ ...combo, [key]: value })));
  }

  return combos.map((overrides) => ({
    label: keys.map((k) => `${k}=${String(overrides[k])}`).join(' '),
    overrides: overrides as ExperimentOverrides,
  }));
}

export interface VariantSummary {
  label: string;
  runs: number;
  /** How many runs passed VERIFICATION, not how many the agent claimed. */
  verified: number;
  /** Runs the agent called a success. Diverging from `verified` is the signal worth looking at. */
  claimed: number;
  /**
   * Runs that never completed — a broken endpoint, a timeout. Counted so a variant whose numbers
   * rest on one surviving run out of five cannot look like a clean result.
   */
  errored: number;
  /**
   * How the runs actually fell out. `verified + wrong + incomplete + broken === runs`.
   *
   * Beside the score rather than folded into it: `incomplete` is work that may well be correct and
   * `broken` is not evidence about this arm at all, so collapsing either into a failure count is
   * how a step budget or an outage gets read as incapability.
   */
  outcomes: OutcomeCounts;
  /**
   * Runs that got a fair attempt — `runs` minus the broken ones.
   *
   * The denominator a score should be read over. Scoring 2 passes out of 15 when 13 never executed
   * is not a cautious reading, it is a wrong one.
   */
  attempted: number;
  /** Medians over COMPLETED runs only. Zero when every run errored. */
  medianTokens: number;
  medianSteps: number;
  medianDurationMs: number;
}

const median = (values: number[]): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  // Median rather than mean: one run that hits the step ceiling is an outlier that drags a mean
  // far enough to reverse the apparent winner.
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
};

/**
 * A run that never completed is not a measurement.
 *
 * It records `steps: 0, tokensUsed: 0` because nothing happened, and feeding those zeros into a
 * median makes a variant look dramatically cheaper for having failed to run at all — one 502 in
 * three repeats halves the apparent step count. Errors are counted separately instead.
 */
const completed = (runs: VariantResult[]): VariantResult[] => runs.filter((r) => !r.error);

const tally = (label: string, runs: VariantResult[]): VariantSummary => {
  const measured = completed(runs);
  const fair = attempted(runs);
  return {
    label,
    runs: runs.length,
    verified: runs.filter((r) => r.verified).length,
    claimed: runs.filter((r) => r.succeeded).length,
    errored: runs.length - measured.length,
    outcomes: countOutcomes(runs),
    attempted: fair.length,
    medianTokens: median(measured.map((r) => r.tokensUsed)),
    medianSteps: median(measured.map((r) => r.steps)),
    medianDurationMs: median(measured.map((r) => r.durationMs)),
  };
};

/**
 * Per variant, across the whole suite.
 *
 * The headline number, and it only means anything because the denominator now spans tasks: a
 * variant at 8/10 is a variant that worked on most of the suite, where the old 2/2 meant it worked
 * twice on one prompt.
 */
export function summariseResults(results: VariantResult[]): VariantSummary[] {
  const byLabel = new Map<string, VariantResult[]>();
  for (const r of results) byLabel.set(r.label, [...(byLabel.get(r.label) ?? []), r]);
  return [...byLabel.entries()].map(([label, runs]) => tally(label, runs));
}

export interface TaskRow {
  taskId: string;
  /** One cell per variant, in the order the variants were given. */
  cells: (VariantSummary & { runs: number })[];
  /**
   * True when every variant scored identically on this task — all passed, or all failed.
   *
   * Not a failure, but not evidence either: a task nothing distinguishes contributes nothing to the
   * comparison while costing a sandbox per variant per repeat. Worth seeing, because a suite made
   * entirely of these reports a confident-looking dead heat.
   */
  uninformative: boolean;
  /** Every variant failed it. Usually the task is broken or impossible, not the harness. */
  allFailed: boolean;
}

/**
 * The tasks × variants matrix.
 *
 * This is where a suite earns its cost. Two variants can finish level on the headline and disagree
 * completely underneath — each winning different tasks — and that is a real finding about what the
 * setting does, invisible to any single aggregate.
 */
export function buildTaskMatrix(
  results: VariantResult[],
  tasks: Pick<ExperimentTask, 'id'>[],
  variants: Pick<ExperimentVariant, 'label'>[],
): TaskRow[] {
  return tasks.map((task) => {
    const forTask = results.filter((r) => taskIdOf(r) === task.id);
    const cells = variants.map((v) => tally(v.label, forTask.filter((r) => r.label === v.label)));
    // Only over cells that actually ran: a variant with no results yet is a gap in the matrix, and
    // treating its zero as agreement would call a task uninformative before it had been measured.
    const scored = cells.filter((c) => c.runs > 0);
    const rates = new Set(scored.map((c) => c.verified / c.runs));

    return {
      taskId: task.id,
      cells,
      uninformative: scored.length > 1 && rates.size === 1,
      allFailed: scored.length > 0 && scored.every((c) => c.verified === 0),
    };
  });
}

/**
 * Tasks that separated the variants, best first.
 *
 * The suite's own report card. A task where variants scored 3/3 and 0/3 did all the work of the
 * experiment; one where they tied did none, and knowing which is which is how the next suite gets
 * better rather than just longer.
 */
export function discriminatingTasks(matrix: TaskRow[]): { taskId: string; spread: number }[] {
  return matrix
    .map((row) => {
      const rates = row.cells.filter((c) => c.runs > 0).map((c) => c.verified / c.runs);
      return {
        taskId: row.taskId,
        spread: rates.length > 1 ? Math.max(...rates) - Math.min(...rates) : 0,
      };
    })
    .filter((t) => t.spread > 0)
    .sort((a, b) => b.spread - a.spread);
}

/**
 * Flags results where the agent claimed success but verification disagreed.
 *
 * Surfaced on its own because it is the failure that silently corrupts everything downstream: a
 * leaf marked succeeded and moved to review on work that was never done.
 */
export function overclaimed(results: VariantResult[]): VariantResult[] {
  return results.filter((r) => r.succeeded && !r.verified);
}

/** Rejects an experiment before it burns GPU time on something malformed. */
export function validateExperiment(input: Partial<Experiment>): string | null {
  if (!input.name?.trim()) return 'Give the experiment a name.';

  const tasks = experimentTasks({
    ...(input.tasks ? { tasks: input.tasks } : {}),
    ...(input.task ? { task: input.task } : {}),
    ...(input.verifyCommand ? { verifyCommand: input.verifyCommand } : {}),
    language: input.language as WorkspaceLanguage,
  });
  if (!tasks.length) return 'Add at least one task — it is what the agent is asked to do.';
  if (tasks.length > MAX_TASKS) return `At most ${MAX_TASKS} tasks in a suite.`;
  if (new Set(tasks.map((t) => t.id)).size !== tasks.length) {
    return 'Two tasks share an id, so their results could not be told apart.';
  }
  for (const task of tasks) {
    const where = task.name?.trim() ? `"${task.name}"` : 'A task';
    if (!task.prompt?.trim()) return `${where} has no prompt — it is what the agent is asked to do.`;
    if (task.prompt.length > MAX_TASK_CHARS) return `${where} is longer than ${MAX_TASK_CHARS} characters.`;
    for (const [field, files] of [['seed', task.seed], ['solution', task.solution]] as const) {
      if (!files) continue;
      if (files.length > MAX_TASK_FILES) return `${where} has more than ${MAX_TASK_FILES} ${field} files.`;
      for (const f of files) {
        if (!f?.path?.trim()) return `${where} has a ${field} file with no path.`;
        // Checked here as well as in the sandbox: a path that escapes should be a message at
        // creation, not an exception halfway through a run that has already cost sandboxes.
        if (f.path.includes('..') || f.path.startsWith('/')) {
          return `${where}: ${field} path "${f.path}" must be relative to /work and must not contain "..".`;
        }
        if ((f.content ?? '').length > MAX_TASK_FILE_CHARS) {
          return `${where}: ${field} file "${f.path}" is longer than ${MAX_TASK_FILE_CHARS} characters.`;
        }
      }
    }
    if (!task.verifyCommand?.trim()) {
      // Per task, not per experiment: tasks in a suite check different things, and one shared
      // command would either fit a single task or be generic enough to verify nothing.
      return `${where} has no verify command — without one the only measure of success is the agent's own report.`;
    }
  }

  if (!input.variants?.length) return 'Add at least one variant.';
  if (input.variants.length > MAX_VARIANTS) {
    // Names the count, because this is almost always reached by selecting a third axis and
    // multiplying past the ceiling without meaning to.
    return `That is ${input.variants.length} variants and the limit is ${MAX_VARIANTS} — `
      + 'each one is a real sandbox. Drop an axis or give it fewer values.';
  }
  if (new Set(input.variants.map((v) => v.label)).size !== input.variants.length) {
    return 'Two variants share a label, so their results could not be told apart.';
  }
  for (const variant of input.variants) {
    // Checked against the registry rather than the type, so an unknown or out-of-range knob is a
    // message here instead of a variant that quietly runs the control configuration.
    const { language: _language, ...callOverrides } = variant.overrides ?? {};
    // The REQUEST layer: a variant may name a model, which is how two engines are compared on one
    // suite. Stated rather than defaulted, so a future layer rule applies here deliberately.
    const bad = validateOverrides(callOverrides, { layer: 'request' });
    if (bad) return `Variant "${variant.label}": ${bad}`;
  }
  const repeats = input.repeats ?? 1;
  if (repeats < 1 || repeats > MAX_REPEATS) return `Repeats must be between 1 and ${MAX_REPEATS}.`;

  // Checked last and against the PRODUCT, because this is the one that is reached by three
  // individually reasonable choices — a fifth task, a third variant, three repeats.
  const total = tasks.length * input.variants.length * repeats;
  if (total > MAX_TOTAL_RUNS) {
    return `${tasks.length} tasks × ${input.variants.length} variants × ${repeats} repeats is `
      + `${total} sandboxes, over the limit of ${MAX_TOTAL_RUNS}. Cut one of the three.`;
  }
  return null;
}

/**
 * Total sandboxes an experiment will create. Shown before it runs, since each is real.
 *
 * Takes the full record rather than a couple of fields, because the task count now belongs in the
 * product and reading it means going through `experimentTasks`.
 */
export function plannedRuns(
  experiment: Pick<Experiment, 'variants' | 'repeats' | 'tasks' | 'task' | 'verifyCommand' | 'language'>,
): number {
  return Math.max(1, experimentTasks(experiment).length)
    * (experiment.variants?.length ?? 0)
    * Math.max(1, experiment.repeats ?? 1);
}
