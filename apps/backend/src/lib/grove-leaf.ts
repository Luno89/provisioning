import type { Task, TaskStatus } from '../engine-host/tools/tasks.js';
import { leafContext } from './plan-documents.js';

export type LeafStep =
  | { kind: 'run'; taskIds: string[] }
  | { kind: 'claim' }
  | { kind: 'fail'; reason: string }
  | { kind: 'unbroken' };

export type LeafTask = Pick<Task, 'id' | 'title' | 'status' | 'dependsOn' | 'evidence' | 'runs'>;

const FINISHED: TaskStatus[] = ['done', 'dropped'];

/**
 * The next step a leaf takes, read from its tasks.
 *
 * The attempt count is the number of runs recorded against each task, so it survives a worker restart — nothing has
 * to remember what was tried in a variable that a replay would lose.
 */
export interface TaskAttemptPolicy {
  taskAttempts?: number | undefined;
}

export function nextLeafStep(tasks: readonly LeafTask[], policy: TaskAttemptPolicy = {}): LeafStep {
  const live = tasks.filter((task) => task.status !== 'proposed');
  if (live.length === 0) return { kind: 'unbroken' };
  if (live.every((task) => FINISHED.includes(task.status))) return { kind: 'claim' };

  const byId = new Map(live.map((task) => [task.id, task]));
  const { taskAttempts } = policy;
  const exhausted = taskAttempts === undefined ? [] : live.filter((task) => task.status === 'failed' && task.runs.length >= taskAttempts);
  if (exhausted.length > 0) {
    const reasons = exhausted.map((task) => `"${task.title}" failed ${task.runs.length} times${task.evidence ? `: ${task.evidence}` : ''}`);
    return { kind: 'fail', reason: reasons.join('; ') };
  }

  const runnable = live.filter((task) =>
    !FINISHED.includes(task.status)
    && task.dependsOn.every((id) => byId.get(id)?.status === undefined || FINISHED.includes(byId.get(id)!.status)));
  if (runnable.length > 0) return { kind: 'run', taskIds: runnable.map((task) => task.id) };

  const stuck = live.filter((task) => !FINISHED.includes(task.status)).map((task) => `"${task.title}"`);
  return { kind: 'fail', reason: `${stuck.join(', ')} can never start: what they wait on did not finish` };
}

export type WorkEnding =
  | { kind: 'claimed' }
  | { kind: 'unbroken' }
  | { kind: 'failed'; reason: string };

export function workEnding(
  run: { outcome: string; reason?: string | undefined; outputs: Readonly<Record<string, unknown>> },
  agent: string,
): WorkEnding {
  if (run.outcome === 'ok') return { kind: 'claimed' };
  const step = run.outputs as { step?: unknown; reason?: unknown };
  if (run.outcome === 'refused' && step.step === 'unbroken') return { kind: 'unbroken' };
  if (step.step === 'fail' && typeof step.reason === 'string' && step.reason.trim()) return { kind: 'failed', reason: step.reason };
  if (run.outcome === 'refused') return { kind: 'failed', reason: `the ${agent} run was refused${run.reason ? `: ${run.reason}` : ''}` };
  return { kind: 'failed', reason: run.reason ?? `the ${agent} run did not finish this leaf` };
}

export type WorkableTask = LeafTask & Pick<Task, 'doneMeans' | 'description' | 'role' | 'checks'>;

export function taskItem(leafId: string, task: WorkableTask, siblings?: string | undefined): Record<string, unknown> {
  return {
    id: task.id,
    title: task.title,
    doneMeans: task.doneMeans,
    leafId,
    context: leafContext(leafId),
    ...(task.description ? { description: task.description } : {}),
    ...(task.role ? { role: task.role } : {}),
    ...(task.checks ? { checks: task.checks } : {}),
    ...(siblings ? { siblings } : {}),
    ...(task.runs.length > 0 && task.evidence ? { previousAttempt: task.evidence } : {}),
  };
}

export function claimEvidence(tasks: readonly LeafTask[]): string {
  return tasks
    .filter((task) => task.status !== 'proposed')
    .map((task) => `- ${task.title} [${task.status}]${task.runs.length ? ` (runs: ${task.runs.join(', ')})` : ''}${task.evidence ? `\n  ${task.evidence.replace(/\n/g, '\n  ')}` : ''}`)
    .join('\n');
}

/**
 * What a work run said for itself, as a claim can carry it.
 *
 * A leaf worked in one run — a paper written rather than a task list finished — has no task evidence,
 * so the run's own outputs are what the judge gets to weigh.
 */
export function runEvidence(outputs: Readonly<Record<string, unknown>>, limit = 2000): string {
  const said = Object.entries(outputs)
    .filter(([name, value]) => name !== 'message' && typeof value === 'string' && value.trim())
    .map(([name, value]) => `${name}: ${String(value).trim()}`)
    .join('\n');

  return said.length > limit ? `${said.slice(0, limit)}…` : said;
}

/**
 * What a claim says for itself.
 *
 * The tasks' evidence, where a task actually reported something. Otherwise the run's own account: a
 * leaf worked in one run — a paper written rather than a task list finished — leaves its tasks
 * sitting at `accepted` with nothing to say, and a judge handed only that has nothing to weigh.
 */
export function claimEvidenceFor(tasks: readonly LeafTask[], runSaid?: string | undefined): string {
  const fromTasks = claimEvidence(tasks);
  const reported = tasks.some((task) => task.status !== 'proposed' && Boolean(task.evidence?.trim()));
  if (reported) return fromTasks;

  const said = runSaid?.trim();
  if (!said) return fromTasks || 'no task reported anything';
  return fromTasks ? `${fromTasks}\n${said}` : said;
}

export interface LeafNeedingPlan {
  leafId: string;
  leafTitle: string;
  leafBody: string;
  mode: 'replan' | 'breakdown';
  failure?: string | undefined;
}

type PlannableLeaf = { id: string; title: string; body?: string | undefined; status: string; replans?: number | undefined; findings?: string | undefined; review?: { reason?: string | undefined } | undefined; claim?: { evidence: string } | undefined };
type PlannableTask = LeafTask & { leafId?: string | undefined };

/**
 * How many times a leaf may be replanned before it is left for the person.
 *
 * Unlimited unless the tree's type says otherwise: the bound that used to live here was arbitrary, and
 * it guarded nothing that is not already guarded — every replan is a proposal a person approves, and
 * every run has its own pass cap. What a type can want is either fewer (a paper that fails twice is
 * worth a person's eye) or none at all (fail the leaf and stop).
 */
export interface ReplanPolicy {
  /** absent means as many as it takes; 0 means never — a failed leaf stays failed for the person */
  attempts?: number | undefined;
}

export function leavesNeedingPlan(
  leaves: readonly PlannableLeaf[],
  tasks: readonly PlannableTask[],
  openProposalLeafIds: ReadonlySet<string>,
  policy: ReplanPolicy = {},
): LeafNeedingPlan[] {
  const needs: LeafNeedingPlan[] = [];
  for (const leaf of leaves) {
    // Every leaf is engine-run; the `runner` field that used to gate this outlived the split it named,
    // and nothing wrote it, so a failed leaf was never replanned and a leaf with no tasks never
    // broken down. A leaf that already has a proposal waiting is the only one left out.
    if (openProposalLeafIds.has(leaf.id)) continue;
    const own = tasks.filter((task) => task.leafId === leaf.id);

    const replansLeft = policy.attempts === undefined || (leaf.replans ?? 0) < policy.attempts;
    if (leaf.status === 'failed' && replansLeft) {
      const failedTasks = own.filter((task) => task.status === 'failed').map((task) => `- task "${task.title}" failed${task.evidence ? `: ${task.evidence}` : ''}`);
      const failure = [
        leaf.findings ? `Why the leaf failed: ${leaf.findings}` : '',
        leaf.review?.reason ? `The judge said: ${leaf.review.reason}` : '',
        ...failedTasks,
        leaf.claim ? `The last claim: ${leaf.claim.evidence}` : '',
      ].filter(Boolean).join('\n');
      needs.push({ leafId: leaf.id, leafTitle: leaf.title, leafBody: leaf.body ?? '', mode: 'replan', ...(failure ? { failure } : {}) });
      continue;
    }

    const live = own.filter((task) => task.status !== 'proposed' && task.status !== 'dropped');
    if (leaf.status === 'pending' && live.length === 0) needs.push({ leafId: leaf.id, leafTitle: leaf.title, leafBody: leaf.body ?? '', mode: 'breakdown' });
  }
  return needs;
}

