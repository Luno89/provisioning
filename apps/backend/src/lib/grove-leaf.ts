import type { Task, TaskStatus } from './tasks.js';

export const TASK_ATTEMPTS = 2;

export type LeafStep =
  | { kind: 'run'; taskIds: string[] }
  | { kind: 'claim' }
  | { kind: 'fail'; reason: string }
  | { kind: 'unbroken' };

export type LeafTask = Pick<Task, 'id' | 'title' | 'status' | 'dependsOn' | 'evidence'>;

const FINISHED: TaskStatus[] = ['done', 'dropped'];

export function nextLeafStep(tasks: readonly LeafTask[], attempts: Readonly<Record<string, number>>): LeafStep {
  const live = tasks.filter((task) => task.status !== 'proposed');
  if (live.length === 0) return { kind: 'unbroken' };
  if (live.every((task) => FINISHED.includes(task.status))) return { kind: 'claim' };

  const byId = new Map(live.map((task) => [task.id, task]));
  const exhausted = live.filter((task) => task.status === 'failed' && (attempts[task.id] ?? 0) >= TASK_ATTEMPTS);
  if (exhausted.length > 0) {
    const reasons = exhausted.map((task) => `"${task.title}" failed ${attempts[task.id]} times${task.evidence ? `: ${task.evidence}` : ''}`);
    return { kind: 'fail', reason: reasons.join('; ') };
  }

  const runnable = live.filter((task) =>
    !FINISHED.includes(task.status)
    && task.dependsOn.every((id) => byId.get(id)?.status === undefined || FINISHED.includes(byId.get(id)!.status)));
  if (runnable.length > 0) return { kind: 'run', taskIds: runnable.map((task) => task.id) };

  const stuck = live.filter((task) => !FINISHED.includes(task.status)).map((task) => `"${task.title}"`);
  return { kind: 'fail', reason: `${stuck.join(', ')} can never start: what they wait on did not finish` };
}

export function claimEvidence(tasks: readonly (LeafTask & { runs?: string[] | undefined })[]): string {
  return tasks
    .filter((task) => task.status !== 'proposed')
    .map((task) => `- ${task.title} [${task.status}]${task.runs?.length ? ` (runs: ${task.runs.join(', ')})` : ''}${task.evidence ? `\n  ${task.evidence.replace(/\n/g, '\n  ')}` : ''}`)
    .join('\n');
}
