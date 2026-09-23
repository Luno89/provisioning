import { randomUUID } from 'node:crypto';
import type { ToolHandler, ToolOutcome } from '@koala/engine-core';
import type { Branch, Leaf } from '../../lib/leaves.js';
import { primaryProjectId, type Tree } from '../../lib/trees.js';
import { SETTLED, type Task, type TaskStatus } from '../../lib/tasks.js';

export interface GroveStores {
  trees: { list(): Promise<Tree[]>; save(tree: Tree): Promise<void> };
  branches: { list(): Promise<Branch[]>; save(branch: Branch): Promise<void> };
  leaves: { list(): Promise<Leaf[]>; save(leaf: Leaf): Promise<void> };
  /** optional here so the P0 planner world (no tasks yet) stays valid; when absent, no leaf has tasks */
  tasks?: { list(): Promise<Task[]> };
}

export interface GroveToolOptions {
  stores: GroveStores;
  newId?: () => string;
  now?: () => string;
}

const refuse = (message: string): ToolOutcome => ({ ok: false, digest: message, content: message });

const asString = (parsed: Record<string, unknown>, key: string): string | undefined => {
  const value = parsed[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

const asStringList = (parsed: Record<string, unknown>, key: string): string[] => {
  const raw = parsed[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '').map((entry) => entry.trim());
};

export function createGroveTools(options: GroveToolOptions): Record<string, ToolHandler> {
  const newId = options.newId ?? randomUUID;
  const now = options.now ?? (() => new Date().toISOString());

  return {
    async make_branch({ parsed, caller }): Promise<ToolOutcome> {
      if (!caller.ownerId) return refuse('this run has no owner to branch a tree for');

      const treeId = asString(parsed, 'treeId') ?? asString(parsed, 'tree_id');
      const title = asString(parsed, 'title');
      if (!treeId) return refuse('make_branch needs a treeId — which tree the direction is under');
      if (!title) return refuse('make_branch needs a title — the direction itself in one line');

      const trees = await options.stores.trees.list();
      const tree = trees.find((candidate) => candidate.id === treeId);
      if (!tree) return refuse(`no such tree: ${treeId} — check the tree id in the run input`);

      const stamp = now();
      const pId = primaryProjectId(tree);
      const branch: Branch = {
        id: newId(),
        ownerId: caller.ownerId,
        treeId,
        ...(pId ? { projectId: pId } : {}),
        title,
        messages: [],
        createdAt: stamp,
        updatedAt: stamp,
      };
      await options.stores.branches.save(branch);

      return { ok: true, digest: `branched ${branch.id}`, content: `branched ${branch.id} — "${title}" under ${treeId}` };
    },

    async make_leaf({ parsed, caller }): Promise<ToolOutcome> {
      if (!caller.ownerId) return refuse('this run has no owner to grow a leaf for');

      const branchId = asString(parsed, 'branchId') ?? asString(parsed, 'branch_id');
      const title = asString(parsed, 'title');
      const body = asString(parsed, 'body') ?? asString(parsed, 'goal');
      if (!branchId) return refuse('make_leaf needs a branchId — the direction the leaf belongs to');
      if (!title) return refuse('make_leaf needs a title — the leaf in a few words');
      if (!body) return refuse('make_leaf needs a body — what the leaf is for, in one or two sentences. That text is what a later judge checks, so make it checkable: name the concrete end state this leaf has to reach.');

      const branches = await options.stores.branches.list();
      const branch = branches.find((candidate) => candidate.id === branchId);
      if (!branch) return refuse(`no such branch: ${branchId} — make it with make_branch first`);

      const dependencies = asStringList(parsed, 'dependsOn').concat(asStringList(parsed, 'depends_on'));
      if (dependencies.length > 0) {
        const leaves = await options.stores.leaves.list();
        const known = new Set(leaves.map((leaf) => leaf.id));
        const unknown = dependencies.filter((id) => !known.has(id));
        if (unknown.length > 0) return refuse(`these leaf dependencies do not exist: ${unknown.join(', ')}`);
      }

      const stamp = now();
      const leaf: Leaf = {
        id: newId(),
        ownerId: caller.ownerId,
        branchId,
        title,
        body,
        column: 'todo',
        status: 'proposed',
        depth: 0,
        blocking: false,
        createdAt: stamp,
        updatedAt: stamp,
        ...(dependencies.length > 0 ? { dependsOn: dependencies } : {}),
      };
      await options.stores.leaves.save(leaf);

      return { ok: true, digest: `grown ${leaf.id}`, content: `grown ${leaf.id} — "${title}" under ${branchId}` };
    },

    async ready_leaves({ parsed }): Promise<ToolOutcome> {
      const treeId = asString(parsed, 'treeId') ?? asString(parsed, 'tree_id');
      if (!treeId) return refuse('ready_leaves needs a treeId — the tree to schedule');

      const trees = await options.stores.trees.list();
      const tree = trees.find((candidate) => candidate.id === treeId);
      if (!tree) return refuse(`no such tree: ${treeId} — check the tree id in the run input`);

      const branches = await options.stores.branches.list();
      const branchOfTree = new Set(branches.filter((branch) => branch.treeId === treeId).map((branch) => branch.id));
      const leaves = (await options.stores.leaves.list()).filter((leaf) => branchOfTree.has(leaf.branchId));
      const byId = new Map(leaves.map((leaf) => [leaf.id, leaf]));

      const openTasksByLeaf = new Map<string, number>();
      if (options.stores.tasks) {
        const tasks = await options.stores.tasks.list();
        for (const task of tasks) {
          if (task.leafId && !SETTLED.includes(task.status)) {
            openTasksByLeaf.set(task.leafId, (openTasksByLeaf.get(task.leafId) ?? 0) + 1);
          }
        }
      }

      const ready: { id: string; title: string; branchId: string; taskCount: number }[] = [];
      const unbroken: { id: string; title: string; branchId: string }[] = [];
      const blocked: { id: string; title: string; waitingOn: string[] }[] = [];
      const notApproved: { id: string; title: string }[] = [];
      const inFlight: { id: string; title: string }[] = [];
      const claimed: { id: string; title: string }[] = [];
      const settled: { id: string; title: string; status: TaskStatus | string }[] = [];

      for (const leaf of leaves) {
        switch (leaf.status) {
          case 'succeeded':
          case 'failed':
          case 'cancelled':
            settled.push({ id: leaf.id, title: leaf.title, status: leaf.status });
            break;
          case 'proposed':
            notApproved.push({ id: leaf.id, title: leaf.title });
            break;
          case 'claimed':
            claimed.push({ id: leaf.id, title: leaf.title });
            break;
          case 'running':
            inFlight.push({ id: leaf.id, title: leaf.title });
            break;
          case 'pending': {
            const waitingOn = (leaf.dependsOn ?? []).filter((dep) => byId.get(dep)?.status !== 'succeeded');
            if (waitingOn.length > 0) {
              blocked.push({ id: leaf.id, title: leaf.title, waitingOn });
            } else if ((openTasksByLeaf.get(leaf.id) ?? 0) === 0) {
              unbroken.push({ id: leaf.id, title: leaf.title, branchId: leaf.branchId });
            } else {
              ready.push({ id: leaf.id, title: leaf.title, branchId: leaf.branchId, taskCount: openTasksByLeaf.get(leaf.id)! });
            }
            break;
          }
        }
      }

      const digest = `${ready.length} ready, ${blocked.length} blocked, ${unbroken.length} without tasks, ${claimed.length} claimed, ${inFlight.length} in flight, ${settled.length} settled — tree ${treeId}`;
      const content = JSON.stringify({ treeId, ready, unbroken, blocked, notApproved, claimed, inFlight, settled }, null, 2);
      return { ok: true, digest, content };
    },
  };
}