import { resetForRetry, runsOnEngine, type Leaf, type Branch } from '../lib/leaves.js';
import type { Tree } from '../lib/trees.js';
import type { Task } from '../lib/tasks.js';
import type { GroveRunStatus } from './TemporalBridge.js';

export interface GroveRunStore {
  getTrees(): Promise<Tree[]>;
  getBranches(): Promise<Branch[]>;
  getLeaves(): Promise<Leaf[]>;
  saveLeaf(leaf: Leaf): Promise<void>;
  getTasks(ownerId?: string): Promise<Task[]>;
  saveTask(task: Task): Promise<void>;
}

export interface GroveRunLauncher {
  startGroveRun(ownerId: string, treeId: string): Promise<{ started: true; workflowId: string } | { started: false; reason: 'unavailable' | 'running' }>;
  groveRunStatus(treeId: string): Promise<GroveRunStatus>;
}

export type GroveRunOutcome<T> = { ok: true; value: T } | { ok: false; status: 404 | 409 | 503; error: string };

export class GroveRunService {
  constructor(private readonly deps: { store: GroveRunStore; launcher: GroveRunLauncher; now?: () => string }) {}

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  private async engineTree(ownerId: string, treeId: string): Promise<GroveRunOutcome<{ tree: Tree; leaves: Leaf[] }>> {
    const tree = (await this.deps.store.getTrees()).find((entry) => entry.id === treeId && entry.ownerId === ownerId);
    if (!tree) return { ok: false, status: 404, error: 'Tree not found' };
    const branchIds = new Set((await this.deps.store.getBranches()).filter((branch) => branch.treeId === treeId).map((branch) => branch.id));
    const leaves = (await this.deps.store.getLeaves()).filter((leaf) => branchIds.has(leaf.branchId));
    if (!leaves.some(runsOnEngine)) {
      return { ok: false, status: 409, error: 'This tree runs on the legacy leaf pipeline; only trees adopted from a plan run on the engine.' };
    }
    return { ok: true, value: { tree, leaves } };
  }

  async status(ownerId: string, treeId: string): Promise<GroveRunOutcome<GroveRunStatus & { engine: boolean }>> {
    const found = await this.engineTree(ownerId, treeId);
    if (!found.ok) return found.status === 409 ? { ok: true, value: { state: 'none', engine: false } } : found;
    return { ok: true, value: { ...(await this.deps.launcher.groveRunStatus(treeId)), engine: true } };
  }

  async run(ownerId: string, treeId: string): Promise<GroveRunOutcome<GroveRunStatus>> {
    const found = await this.engineTree(ownerId, treeId);
    if (!found.ok) return found;
    const started = await this.deps.launcher.startGroveRun(ownerId, treeId);
    if (!started.started && started.reason === 'unavailable') return { ok: false, status: 503, error: 'Temporal is not reachable, so the tree cannot run.' };
    return { ok: true, value: await this.deps.launcher.groveRunStatus(treeId) };
  }

  async retryLeaf(ownerId: string, leaf: Leaf): Promise<GroveRunOutcome<Leaf>> {
    if (leaf.status !== 'failed') return { ok: false, status: 409, error: `Only a failed leaf can be retried; this one is ${leaf.status}.` };
    const branch = (await this.deps.store.getBranches()).find((entry) => entry.id === leaf.branchId);
    if (!branch?.treeId) return { ok: false, status: 409, error: 'This leaf belongs to no tree, so there is nothing to run it in.' };

    const tasks = (await this.deps.store.getTasks(ownerId)).filter((task) => task.leafId === leaf.id);
    const reset = resetForRetry(leaf, tasks, this.now());
    await this.deps.store.saveLeaf(reset.leaf);
    for (const task of reset.tasks) await this.deps.store.saveTask(task);

    const started = await this.deps.launcher.startGroveRun(ownerId, branch.treeId);
    if (!started.started && started.reason === 'unavailable') return { ok: false, status: 503, error: 'The leaf is reset, but Temporal is not reachable to run the tree.' };
    return { ok: true, value: reset.leaf };
  }
}
