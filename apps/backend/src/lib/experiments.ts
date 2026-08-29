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

const MAX_SUMMARY_ERROR = 200;

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

export function latestResults(
  experiment: Pick<Experiment, 'runs' | 'results'>,
): VariantResult[] {
  const last = experiment.runs?.[experiment.runs.length - 1];
  return last ? last.results : (experiment.results ?? []);
}

export function priorExecutions(experiment: Experiment): ExperimentRun[] {
  if (experiment.runs) return experiment.runs;
  if (!experiment.results?.length) return [];
  return [{
    id: 'r0',
    startedAt: experiment.createdAt,
    finishedAt: experiment.updatedAt,
    status: experiment.status === 'failed' ? 'failed' : 'complete',
    results: experiment.results,
  }];
}

export function currentRun(experiment: Pick<Experiment, 'runs'>): ExperimentRun | undefined {
  return experiment.runs?.[experiment.runs.length - 1];
}

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

export function normaliseExperiment(experiment: Experiment): Experiment {
  return {
    ...experiment,
    tasks: experimentTasks(experiment),
    results: latestResults(experiment).map((r) => ({ ...r, taskId: taskIdOf(r) })),
    ...(experiment.runs
      ? { runs: experiment.runs.map((run) => ({
          ...run,
          results: run.results.map((r) => ({ ...r, taskId: taskIdOf(r) })),
        })) }
      : {}),
  };
}

export const MAX_VARIANTS = 6;
export const MAX_REPEATS = 5;
export const MAX_TASK_CHARS = 8000;
export const MAX_TASKS = 10;
export const MAX_TASK_FILES = 10;
export const MAX_TASK_FILE_CHARS = 20_000;
export const MAX_TOTAL_RUNS = 60;

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

export const LEGACY_TASK_ID = 'task';

export const taskIdOf = (result: VariantResult): string => result.taskId ?? LEGACY_TASK_ID;

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
  verified: number;
  claimed: number;
  errored: number;
  outcomes: OutcomeCounts;
  attempted: number;
  medianTokens: number;
  medianSteps: number;
  medianDurationMs: number;
}

const median = (values: number[]): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
};

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

export function summariseResults(results: VariantResult[]): VariantSummary[] {
  const byLabel = new Map<string, VariantResult[]>();
  for (const r of results) byLabel.set(r.label, [...(byLabel.get(r.label) ?? []), r]);
  return [...byLabel.entries()].map(([label, runs]) => tally(label, runs));
}

export interface TaskRow {
  taskId: string;
  cells: (VariantSummary & { runs: number })[];
  uninformative: boolean;
  allFailed: boolean;
}

export function buildTaskMatrix(
  results: VariantResult[],
  tasks: Pick<ExperimentTask, 'id'>[],
  variants: Pick<ExperimentVariant, 'label'>[],
): TaskRow[] {
  return tasks.map((task) => {
    const forTask = results.filter((r) => taskIdOf(r) === task.id);
    const cells = variants.map((v) => tally(v.label, forTask.filter((r) => r.label === v.label)));
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

export function overclaimed(results: VariantResult[]): VariantResult[] {
  return results.filter((r) => r.succeeded && !r.verified);
}

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
        if (f.path.includes('..') || f.path.startsWith('/')) {
          return `${where}: ${field} path "${f.path}" must be relative to /work and must not contain "..".`;
        }
        if ((f.content ?? '').length > MAX_TASK_FILE_CHARS) {
          return `${where}: ${field} file "${f.path}" is longer than ${MAX_TASK_FILE_CHARS} characters.`;
        }
      }
    }
    if (!task.verifyCommand?.trim()) {
      return `${where} has no verify command — without one the only measure of success is the agent's own report.`;
    }
  }

  if (!input.variants?.length) return 'Add at least one variant.';
  if (input.variants.length > MAX_VARIANTS) {
    return `That is ${input.variants.length} variants and the limit is ${MAX_VARIANTS} — `
      + 'each one is a real sandbox. Drop an axis or give it fewer values.';
  }
  if (new Set(input.variants.map((v) => v.label)).size !== input.variants.length) {
    return 'Two variants share a label, so their results could not be told apart.';
  }
  for (const variant of input.variants) {
    const { language: _language, ...callOverrides } = variant.overrides ?? {};
    const bad = validateOverrides(callOverrides, { layer: 'request' });
    if (bad) return `Variant "${variant.label}": ${bad}`;
  }
  const repeats = input.repeats ?? 1;
  if (repeats < 1 || repeats > MAX_REPEATS) return `Repeats must be between 1 and ${MAX_REPEATS}.`;

  const total = tasks.length * input.variants.length * repeats;
  if (total > MAX_TOTAL_RUNS) {
    return `${tasks.length} tasks × ${input.variants.length} variants × ${repeats} repeats is `
      + `${total} sandboxes, over the limit of ${MAX_TOTAL_RUNS}. Cut one of the three.`;
  }
  return null;
}

export function plannedRuns(
  experiment: Pick<Experiment, 'variants' | 'repeats' | 'tasks' | 'task' | 'verifyCommand' | 'language'>,
): number {
  return Math.max(1, experimentTasks(experiment).length)
    * Math.max(1, experiment.variants?.length ?? 0)
    * Math.max(1, experiment.repeats ?? 1);
}
