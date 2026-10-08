import type { Leaf } from './leaves.js';
import type { Task } from '../engine-host/tools/tasks.js';

export const CONFLICT_TASK_TITLE = 'Merge main into this leaf and resolve the conflict';

export const readyToLand = (leaf: Pick<Leaf, 'status' | 'verified' | 'landed'>): boolean =>
  leaf.status === 'succeeded' && leaf.verified === true && !leaf.landed;

export function landingOrder<T extends Pick<Leaf, 'id' | 'dependsOn'>>(leaves: readonly T[]): T[] {
  const pending = new Map(leaves.map((leaf) => [leaf.id, leaf]));
  const ordered: T[] = [];
  while (pending.size > 0) {
    const next = [...pending.values()].find((leaf) => !(leaf.dependsOn ?? []).some((id) => pending.has(id))) ?? pending.values().next().value!;
    ordered.push(next);
    pending.delete(next.id);
  }
  return ordered;
}

export const landedLeaf = (leaf: Leaf, outcome: 'merged' | 'nothing', at: string): Leaf => ({ ...leaf, landed: { at, outcome }, updatedAt: at });

export interface ConflictTask {
  title: string;
  description: string;
  doneMeans: string;
  checks: { command: string; expects: string[] };
}

export const conflictTask = (leaf: Pick<Leaf, 'title'>): ConflictTask => ({
  title: CONFLICT_TASK_TITLE,
  description: `"${leaf.title}" was verified, but another leaf landed on main first and changed some of the same lines, so its work could not be merged. `
    + 'In this leaf\'s worktree, merge main into its branch (git merge main), resolve every conflict so both changes still do what they were meant to, '
    + 'run what the leaf\'s goal needs to show it still holds, and commit the merge.',
  doneMeans: 'main is merged into the leaf\'s branch with no conflicts left, and the leaf\'s goal still holds',
  checks: { command: 'git merge-base --is-ancestor main HEAD && echo merged', expects: ['merged'] },
});

export function reopenForConflict(leaf: Leaf, taskId: string, at: string): Leaf {
  const { claim: _claim, review: _review, landed: _landed, ...rest } = leaf;
  return {
    ...rest,
    status: 'pending',
    verified: false,
    tasks: [...(leaf.tasks ?? []), taskId],
    findings: `It was verified, but merging it into main conflicted with work that landed first; it now has a task to merge main in and resolve that.`,
    updatedAt: at,
  };
}

export const SUPERSEDED_NOTE = 'dropped: the judge verified the leaf without it, before merging the leaf into main conflicted';

export function supersededByVerdict(tasks: readonly Task[], leafId: string, at: string): Task[] {
  return tasks
    .filter((task) => task.leafId === leafId && task.status === 'failed')
    .map((task) => ({ ...task, status: 'dropped', evidence: task.evidence ? `${task.evidence}\n${SUPERSEDED_NOTE}` : SUPERSEDED_NOTE, updatedAt: at }));
}
