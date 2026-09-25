import type { Database } from '../lib/db-interface.js';
import { treeOutline } from '../lib/tree-outline.js';

type BindingSources = Pick<Database, 'getConversation' | 'getTrees' | 'getBranches' | 'getLeaves' | 'getTasks' | 'getProjects'>;

export function conversationBinding(db: BindingSources) {
  return async (ownerId: string, conversationId: string): Promise<Record<string, string> | undefined> => {
    const conversation = await db.getConversation(ownerId, conversationId);
    if (conversation?.treeId) {
      const tree = (await db.getTrees()).find((candidate) => candidate.id === conversation.treeId && candidate.ownerId === ownerId);
      if (!tree) return undefined;
      const branches = (await db.getBranches()).filter((branch) => branch.treeId === tree.id);
      const branchIds = new Set(branches.map((branch) => branch.id));
      const leaves = (await db.getLeaves()).filter((leaf) => branchIds.has(leaf.branchId));
      const leafIds = new Set(leaves.map((leaf) => leaf.id));
      const tasks = (await db.getTasks(ownerId)).filter((task) => task.leafId && leafIds.has(task.leafId));
      return { treeId: tree.id, tree: treeOutline(tree, branches, leaves, tasks) };
    }
    if (conversation?.projectId) {
      const project = (await db.getProjects()).find((candidate) => candidate.id === conversation.projectId && candidate.ownerId === ownerId);
      if (!project) return undefined;
      return {
        projectId: project.id,
        project: `Project "${project.name}" (${project.id}). It has no Grove tree yet: a new tree planned in this conversation is linked to it when the person approves the plan.`,
      };
    }
    return undefined;
  };
}
