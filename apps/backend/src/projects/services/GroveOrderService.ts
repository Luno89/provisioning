import type { Database } from '../../platform/lib/db-interface.js';
import { orderProblem, ranked } from '../lib/work-order.js';

export type GroveOrderStore = Pick<Database, 'getTrees' | 'getBranches' | 'getLeaves' | 'saveBranch' | 'saveLeaf'>;

export type OrderOutcome = { ok: true; value: { ordered: number } } | { ok: false; status: 400 | 404; error: string };

export class GroveOrderService {
  constructor(private readonly deps: { store: GroveOrderStore; now?: () => string }) {}

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  async orderStories(ownerId: string, branchId: string, order: unknown): Promise<OrderOutcome> {
    const branch = (await this.deps.store.getBranches()).find((entry) => entry.id === branchId && entry.ownerId === ownerId);
    if (!branch) return { ok: false, status: 404, error: 'Feature not found' };
    const leaves = (await this.deps.store.getLeaves()).filter((leaf) => leaf.branchId === branch.id && leaf.ownerId === ownerId);
    const problem = orderProblem(order, leaves.map((leaf) => leaf.id), 'stories');
    if (problem) return { ok: false, status: 400, error: problem };
    const changed = ranked(leaves, order as string[], this.now());
    for (const leaf of changed) await this.deps.store.saveLeaf(leaf);
    return { ok: true, value: { ordered: changed.length } };
  }

  async orderFeatures(ownerId: string, treeId: string, order: unknown): Promise<OrderOutcome> {
    const tree = (await this.deps.store.getTrees()).find((entry) => entry.id === treeId && entry.ownerId === ownerId);
    if (!tree) return { ok: false, status: 404, error: 'Tree not found' };
    const branches = (await this.deps.store.getBranches()).filter((branch) => branch.treeId === tree.id && branch.ownerId === ownerId);
    const problem = orderProblem(order, branches.map((branch) => branch.id), 'features');
    if (problem) return { ok: false, status: 400, error: problem };
    const changed = ranked(branches, order as string[], this.now());
    for (const branch of changed) await this.deps.store.saveBranch(branch);
    return { ok: true, value: { ordered: changed.length } };
  }
}
