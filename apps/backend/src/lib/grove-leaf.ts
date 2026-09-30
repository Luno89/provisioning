import type { Task, TaskStatus } from '../engine-host/tools/tasks.js';

export const TASK_ATTEMPTS = 2;

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
export function nextLeafStep(tasks: readonly LeafTask[]): LeafStep {
  const live = tasks.filter((task) => task.status !== 'proposed');
  if (live.length === 0) return { kind: 'unbroken' };
  if (live.every((task) => FINISHED.includes(task.status))) return { kind: 'claim' };

  const byId = new Map(live.map((task) => [task.id, task]));
  const exhausted = live.filter((task) => task.status === 'failed' && task.runs.length >= TASK_ATTEMPTS);
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

export const MAX_REPLANS = 2;

export interface LeafNeedingPlan {
  leafId: string;
  leafTitle: string;
  leafBody: string;
  mode: 'replan' | 'breakdown';
  failure?: string | undefined;
}

type PlannableLeaf = { id: string; title: string; body?: string | undefined; status: string; replans?: number | undefined; findings?: string | undefined; review?: { reason?: string | undefined } | undefined; claim?: { evidence: string } | undefined };
type PlannableTask = LeafTask & { leafId?: string | undefined };

export function leavesNeedingPlan(
  leaves: readonly PlannableLeaf[],
  tasks: readonly PlannableTask[],
  openProposalLeafIds: ReadonlySet<string>,
): LeafNeedingPlan[] {
  const needs: LeafNeedingPlan[] = [];
  for (const leaf of leaves) {
    // Every leaf is engine-run; the `runner` field that used to gate this outlived the split it named,
    // and nothing wrote it, so a failed leaf was never replanned and a leaf with no tasks never
    // broken down. A leaf that already has a proposal waiting is the only one left out.
    if (openProposalLeafIds.has(leaf.id)) continue;
    const own = tasks.filter((task) => task.leafId === leaf.id);

    if (leaf.status === 'failed' && (leaf.replans ?? 0) < MAX_REPLANS) {
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

