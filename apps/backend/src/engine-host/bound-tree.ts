import type { Database } from '../lib/db-interface.js';
import { treeOutline } from '../lib/tree-outline.js';
import type { BoundTree } from './registries/run-starter.js';

type BoundTreeSources = Pick<Database, 'getConversation' | 'getTrees' | 'getBranches' | 'getLeaves' | 'getTasks'>;

export function boundTreeReader(db: BoundTreeSources) {
  return async (ownerId: string, conversationId: string): Promise<BoundTree | undefined> => {
    const treeId = (await db.getConversation(ownerId, conversationId))?.treeId;
    if (!treeId) return undefined;
    const tree = (await db.getTrees()).find((candidate) => candidate.id === treeId && candidate.ownerId === ownerId);
    if (!tree) return undefined;
    const branches = (await db.getBranches()).filter((branch) => branch.treeId === tree.id);
    const branchIds = new Set(branches.map((branch) => branch.id));
    const leaves = (await db.getLeaves()).filter((leaf) => branchIds.has(leaf.branchId));
    const leafIds = new Set(leaves.map((leaf) => leaf.id));
    const tasks = (await db.getTasks(ownerId)).filter((task) => task.leafId && leafIds.has(task.leafId));
    return { treeId: tree.id, outline: treeOutline(tree, branches, leaves, tasks) };
  };
}
