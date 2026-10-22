import { withStatus, type Task, type TaskStatus } from '../engine-host/index.js';

export interface TaskAccess {
  list(ownerId: string): Promise<Task[]>;
  save(task: Task): Promise<void>;
}

export type Accepted = (ownerId: string, task: Task) => Promise<{ waiting: string[] } | undefined>;

export async function decideTask(tasks: TaskAccess, accepted: Accepted | undefined, ownerId: string, taskId: string, status: Extract<TaskStatus, 'accepted' | 'dropped'>, now = new Date().toISOString()): Promise<Task | undefined> {
  const task = (await tasks.list(ownerId)).find((candidate) => candidate.id === taskId);
  if (!task) return undefined;
  const updated = withStatus(task, status, now);
  await tasks.save(updated);
  const needs = status === 'accepted' ? await accepted?.(ownerId, updated) : undefined;
  return needs?.waiting.includes(updated.id) ? (await tasks.list(ownerId)).find((candidate) => candidate.id === updated.id) ?? updated : updated;
}
