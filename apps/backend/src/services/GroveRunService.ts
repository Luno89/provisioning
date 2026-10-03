import { resetForRetry, settleClaim, type Leaf, type Branch } from '../lib/leaves.js';
import type { Tree } from '../lib/trees.js';
import type { Task } from '../engine-host/tools/tasks.js';
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
  startGroveRun(ownerId: string, treeId: string): Promise<{ started: true; workflowId: string } | { started: false; reason: 'unavailable' | 'running' | 'switched-off' }>;
  groveRunStatus(treeId: string): Promise<GroveRunStatus>;
  signalGroveRun(treeId: string, signal: 'stopRun' | 'cancelLeaf', ...args: string[]): Promise<boolean>;
}

const SWITCHED_OFF = 'The agent that grows this tree belongs to an extension you have switched off — switch it on in Extensions to run the tree.';

export type GroveRunOutcome<T> = { ok: true; value: T } | { ok: false; status: 400 | 404 | 409 | 503; error: string };

export class GroveRunService {
  constructor(private readonly deps: { store: GroveRunStore; launcher: GroveRunLauncher; now?: () => string }) {}

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  private async ownedTree(ownerId: string, treeId: string): Promise<GroveRunOutcome<{ tree: Tree; leaves: Leaf[] }>> {
    const tree = (await this.deps.store.getTrees()).find((entry) => entry.id === treeId && entry.ownerId === ownerId);
    if (!tree) return { ok: false, status: 404, error: 'Tree not found' };
    const branches = (await this.deps.store.getBranches()).filter((branch) => branch.treeId === treeId);
    const branchIds = new Set(branches.map((branch) => branch.id));
    const leaves = (await this.deps.store.getLeaves()).filter((leaf) => branchIds.has(leaf.branchId));
    return { ok: true, value: { tree, leaves } };
  }

  async status(ownerId: string, treeId: string): Promise<GroveRunOutcome<GroveRunStatus>> {
    const found = await this.ownedTree(ownerId, treeId);
    if (!found.ok) return found;
    return { ok: true, value: await this.deps.launcher.groveRunStatus(treeId) };
  }

  async run(ownerId: string, treeId: string): Promise<GroveRunOutcome<GroveRunStatus>> {
    const found = await this.ownedTree(ownerId, treeId);
    if (!found.ok) return found;
    if (found.value.leaves.length === 0) return { ok: false, status: 409, error: 'Nothing is planned in this tree yet — ask for work in its conversation, and approve the plan.' };
    const started = await this.deps.launcher.startGroveRun(ownerId, treeId);
    if (!started.started && started.reason === 'unavailable') return { ok: false, status: 503, error: 'Temporal is not reachable, so the tree cannot run.' };
    if (!started.started && started.reason === 'switched-off') return { ok: false, status: 409, error: SWITCHED_OFF };
    return { ok: true, value: await this.deps.launcher.groveRunStatus(treeId) };
  }

  async stop(ownerId: string, treeId: string): Promise<GroveRunOutcome<GroveRunStatus>> {
    const found = await this.ownedTree(ownerId, treeId);
    if (!found.ok) return found;
    const signalled = await this.deps.launcher.signalGroveRun(treeId, 'stopRun');
    if (!signalled) return { ok: false, status: 409, error: 'The tree is not running.' };
    return { ok: true, value: await this.deps.launcher.groveRunStatus(treeId) };
  }

  async cancelLeaf(ownerId: string, leaf: Leaf): Promise<GroveRunOutcome<Leaf>> {
    if (!['pending', 'running', 'claimed'].includes(leaf.status)) {
      return { ok: false, status: 409, error: `Only unfinished work can be cancelled; this leaf is ${leaf.status}.` };
    }
    const cancelled: Leaf = { ...leaf, status: 'cancelled', updatedAt: this.now() };
    await this.deps.store.saveLeaf(cancelled);
    const treeId = (await this.deps.store.getBranches()).find((branch) => branch.id === leaf.branchId)?.treeId;
    if (treeId) await this.deps.launcher.signalGroveRun(treeId, 'cancelLeaf', leaf.id);
    return { ok: true, value: cancelled };
  }

  async settleClaim(leaf: Leaf, verdict: 'verified' | 'failed', note: string | undefined): Promise<GroveRunOutcome<Leaf>> {
    const outcome = settleClaim(leaf, { verdict, note, by: 'person', at: this.now() });
    if ('problem' in outcome) return { ok: false, status: 409, error: outcome.problem };
    await this.deps.store.saveLeaf(outcome.leaf);
    return { ok: true, value: outcome.leaf };
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
    if (!started.started && started.reason === 'switched-off') return { ok: false, status: 409, error: `The leaf is reset, but ${SWITCHED_OFF.charAt(0).toLowerCase()}${SWITCHED_OFF.slice(1)}` };
    return { ok: true, value: reset.leaf };
  }
}
