import type { WorkspaceDependency } from '@koala/agent-engine';
import { checksNeed } from '../lib/browser-tests.js';
import type { PublishedWorkspace } from '../lib/published-workspace.js';
import type { WorkspaceChange } from '../lib/workspace-file.js';
import { withStatus, type Task } from './tools/tasks.js';

export interface CheckNeedsDeps {
  tasks: { list(ownerId: string): Promise<Task[]>; save(task: Task): Promise<void> };
  published: (ownerId: string, treeId: string) => Promise<PublishedWorkspace | undefined>;
  dependencies: (ownerId: string) => Promise<readonly WorkspaceDependency[]>;
  change: (ownerId: string, treeId: string, change: WorkspaceChange, said: string) => Promise<{ ok: true; written: boolean; commit?: string | undefined; file: { needs?: string[] | undefined } } | { ok: false; why: string }>;
  build: (ownerId: string, treeId: string, commit: string) => Promise<unknown>;
  now?: (() => string) | undefined;
}

export interface CheckNeedsOutcome {
  added: string[];
  waiting: string[];
  refused?: string | undefined;
}

export type CheckNeeds = (ownerId: string, treeId: string, taskIds: readonly string[]) => Promise<CheckNeedsOutcome>;

export function createCheckNeeds(deps: CheckNeedsDeps): CheckNeeds {
  const now = deps.now ?? (() => new Date().toISOString());
  return async (ownerId, treeId, taskIds) => {
    const ids = new Set(taskIds);
    const tasks = (await deps.tasks.list(ownerId)).filter((task) => ids.has(task.id) && task.status !== 'done' && task.status !== 'dropped');
    const wanted = [...new Set(tasks.flatMap((task) => checksNeed(task.checks)))];
    if (wanted.length === 0) return { added: [], waiting: [] };

    const [catalogue, published] = await Promise.all([deps.dependencies(ownerId), deps.published(ownerId, treeId)]);
    const built = (name: string): boolean => {
      const dependency = catalogue.find((entry) => entry.name === name);
      return Boolean(published && dependency && dependency.provides.length > 0 && dependency.provides.every((program) => published.provides.includes(program)));
    };
    const missing = wanted.filter((name) => !built(name));
    if (missing.length === 0) return { added: [], waiting: [] };

    const written = await deps.change(ownerId, treeId, { needs: missing }, `The checks of the approved work need ${missing.join(', ')} in the workspace.`);
    if (!written.ok) return { added: [], waiting: [], refused: written.why };
    if (written.written && written.commit) await deps.build(ownerId, treeId, written.commit);
    if (!published) return { added: written.written ? missing : [], waiting: [] };

    const waiting: string[] = [];
    for (const task of tasks) {
      const needs = checksNeed(task.checks).filter((name) => missing.includes(name));
      if (needs.length === 0 || task.status === 'waiting') continue;
      await deps.tasks.save({ ...withStatus(task, 'waiting', now()), evidence: `waits for the workspace to get ${needs.join(', ')}: its checks need ${needs.length === 1 ? 'it' : 'them'}` });
      waiting.push(task.id);
    }
    return { added: written.written ? missing : [], waiting };
  };
}

export function needsOfAccepted(
  checkNeeds: CheckNeeds,
  grove: { leaves: { list(): Promise<{ id: string; branchId: string }[]> }; branches: { list(): Promise<{ id: string; treeId: string }[]> } },
): (ownerId: string, task: Task) => Promise<CheckNeedsOutcome | undefined> {
  return async (ownerId, task) => {
    if (!task.leafId || checksNeed(task.checks).length === 0) return undefined;
    const leaf = (await grove.leaves.list()).find((entry) => entry.id === task.leafId);
    const branch = leaf ? (await grove.branches.list()).find((entry) => entry.id === leaf.branchId) : undefined;
    return branch ? checkNeeds(ownerId, branch.treeId, [task.id]) : undefined;
  };
}
