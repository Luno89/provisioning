export type TaskStatus = 'proposed' | 'accepted' | 'running' | 'done' | 'failed' | 'dropped';

export interface TaskChecks {
  command?: string | undefined;
  expects?: string[] | undefined;
}

export interface Task {
  id: string;
  ownerId: string;
  projectId?: string | undefined;
  title: string;
  intent?: string | undefined;
  doneMeans: string;
  checks?: TaskChecks | undefined;
  dependsOn: string[];
  parentTaskId?: string | undefined;
  agent?: string | undefined;
  status: TaskStatus;
  runs: string[];
  evidence?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export const SETTLED: TaskStatus[] = ['done', 'dropped'];

export const MAX_TITLE = 200;
export const MAX_DONE_MEANS = 2_000;

export interface ProposedTask {
  title: string;
  doneMeans: string;
  intent?: string | undefined;
  dependsOn?: string[] | undefined;
  agent?: string | undefined;
  checks?: TaskChecks | undefined;
  parentTaskId?: string | undefined;
}

export function describeProblem(input: Partial<ProposedTask>): string | undefined {
  if (!input.title?.trim()) return 'a task needs a title';
  if (input.title.trim().length > MAX_TITLE) return `a title has to be under ${MAX_TITLE} characters`;
  if (!input.doneMeans?.trim()) return 'a task needs to say what "done" means, so anyone can tell whether it worked';
  if (input.doneMeans.trim().length > MAX_DONE_MEANS) return `"done means" has to be under ${MAX_DONE_MEANS} characters`;
  return undefined;
}

export const isSettled = (task: Pick<Task, 'status'>): boolean => SETTLED.includes(task.status);

export function blockedBy(task: Pick<Task, 'dependsOn'>, all: readonly Task[]): Task[] {
  const byId = new Map(all.map((candidate) => [candidate.id, candidate]));
  return task.dependsOn
    .map((id) => byId.get(id))
    .filter((dependency): dependency is Task => dependency !== undefined && dependency.status !== 'done');
}

export function danglingDependencies(task: Pick<Task, 'dependsOn'>, all: readonly Task[]): string[] {
  const known = new Set(all.map((candidate) => candidate.id));
  return task.dependsOn.filter((id) => !known.has(id));
}

export function isReady(task: Task, all: readonly Task[]): boolean {
  if (task.status !== 'accepted') return false;
  if (danglingDependencies(task, all).length > 0) return false;
  return blockedBy(task, all).length === 0;
}

export function readyTasks(all: readonly Task[]): Task[] {
  return all.filter((task) => isReady(task, all));
}

/**
 * What a finishing task unblocked. Only tasks that depend on it directly and have nothing else
 * outstanding — so a completing run can start exactly what it made possible and nothing else.
 */
export function unblockedBy(completedId: string, all: readonly Task[]): Task[] {
  return all.filter((task) =>
    task.dependsOn.includes(completedId)
    && isReady(task, all));
}

export function withStatus(task: Task, status: TaskStatus, now: string): Task {
  return { ...task, status, updatedAt: now };
}

export function withRun(task: Task, runId: string, now: string): Task {
  return {
    ...task,
    runs: task.runs.includes(runId) ? task.runs : [...task.runs, runId],
    updatedAt: now,
  };
}

export function newTask(input: ProposedTask & { id: string; ownerId: string; projectId?: string | undefined }, now: string): Task {
  return {
    id: input.id,
    ownerId: input.ownerId,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    title: input.title.trim(),
    ...(input.intent?.trim() ? { intent: input.intent.trim() } : {}),
    doneMeans: input.doneMeans.trim(),
    ...(input.checks ? { checks: input.checks } : {}),
    dependsOn: [...(input.dependsOn ?? [])],
    ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
    ...(input.agent ? { agent: input.agent } : {}),
    status: 'proposed',
    runs: [],
    createdAt: now,
    updatedAt: now,
  };
}

export interface CycleReport {
  hasCycle: boolean;
  members: string[];
}

export function findCycle(all: readonly Task[]): CycleReport {
  const byId = new Map(all.map((task) => [task.id, task]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const walk = (id: string): string[] | undefined => {
    if (state.get(id) === 'done') return undefined;
    if (state.get(id) === 'visiting') return [...stack.slice(stack.indexOf(id)), id];

    state.set(id, 'visiting');
    stack.push(id);

    for (const next of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(next)) continue;
      const found = walk(next);
      if (found) return found;
    }

    stack.pop();
    state.set(id, 'done');
    return undefined;
  };

  for (const task of all) {
    const found = walk(task.id);
    if (found) return { hasCycle: true, members: found };
  }

  return { hasCycle: false, members: [] };
}
