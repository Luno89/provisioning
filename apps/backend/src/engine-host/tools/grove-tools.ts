import { randomUUID } from 'node:crypto';
import type { ToolHandler, ToolOutcome } from '@koala/engine-core';
import { awaitingReview, settleClaim, type Branch, type Leaf } from '../../lib/leaves.js';
import { primaryProjectId, type Tree } from '../../lib/trees.js';
import { SETTLED, type Task, type TaskStatus } from '../../lib/tasks.js';
import { parsePlan, planSummary, type PlanProposal } from '../../lib/plan-proposals.js';
import { worktreeHead } from '../grove-worktrees.js';

export interface GroveStores {
  trees: { list(): Promise<Tree[]>; save(tree: Tree): Promise<void> };
  branches: { list(): Promise<Branch[]>; save(branch: Branch): Promise<void> };
  leaves: { list(): Promise<Leaf[]>; save(leaf: Leaf): Promise<void> };
  /** optional here so the P0 planner world (no tasks yet) stays valid; when absent, no leaf has tasks */
  tasks?: { list(): Promise<Task[]> };
  plans?: {
    save(proposal: PlanProposal): Promise<void>;
    list(ownerId: string, conversationId?: string): Promise<PlanProposal[]>;
  };
  treeTypes?: (ownerId: string) => Promise<TreeTypeChoice[]>;
}

export interface TreeTypeChoice {
  id: string;
  label: string;
  summary: string;
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

  const treeTypesOf = async (ownerId: string): Promise<TreeTypeChoice[]> =>
    (options.stores.treeTypes ? await options.stores.treeTypes(ownerId) : []);

  return {
    async list_tree_types({ caller }): Promise<ToolOutcome> {
      if (!caller.ownerId) return refuse('this run has no owner whose tree types to list');
      const types = await treeTypesOf(caller.ownerId);
      if (types.length === 0) return refuse('this person has no tree types set up, so no new tree can be proposed');
      const lines = types.map((type) => `- ${type.id} — ${type.label}: ${type.summary}`);
      return { ok: true, digest: `${types.length} tree types`, content: `The tree types a new tree can be:\n${lines.join('\n')}` };
    },

    async propose_plan({ parsed, caller }): Promise<ToolOutcome> {
      if (!caller.ownerId) return refuse('this run has no owner to propose a plan for');
      if (!options.stores.plans) return refuse('plans cannot be proposed here — nothing is set up to keep them for approval');

      const treeId = asString(parsed, 'treeId') ?? asString(parsed, 'tree_id');
      let existingLeafIds = new Set<string>();
      if (treeId) {
        const tree = (await options.stores.trees.list()).find((candidate) => candidate.id === treeId && candidate.ownerId === caller.ownerId);
        if (!tree) return refuse(`no such tree: ${treeId} — to start a new tree, leave treeId out and describe it under tree: { name, type, goal }`);
        const branchIds = new Set((await options.stores.branches.list()).filter((branch) => branch.treeId === treeId).map((branch) => branch.id));
        existingLeafIds = new Set((await options.stores.leaves.list()).filter((leaf) => branchIds.has(leaf.branchId)).map((leaf) => leaf.id));
      }

      const outcome = parsePlan(parsed, {
        treeTypes: (await treeTypesOf(caller.ownerId)).map((type) => type.id),
        existingLeafIds,
      });
      if ('problem' in outcome) return refuse(`${outcome.problem}. Nothing was saved — send the whole plan again with that fixed.`);

      const stamp = now();
      const proposal: PlanProposal = {
        id: newId(),
        ownerId: caller.ownerId,
        ...(caller.conversationId ? { conversationId: caller.conversationId } : {}),
        ...(caller.runId ? { runId: caller.runId } : {}),
        status: 'proposed',
        plan: outcome.plan,
        createdAt: stamp,
        updatedAt: stamp,
      };
      const earlier = (await options.stores.plans.list(caller.ownerId, caller.conversationId))
        .filter((entry) => entry.status === 'proposed' && (caller.conversationId ? true : entry.runId === caller.runId));
      for (const entry of earlier) await options.stores.plans.save({ ...entry, status: 'superseded', updatedAt: stamp });
      await options.stores.plans.save(proposal);

      const summary = planSummary(outcome.plan);
      return {
        ok: true,
        digest: `proposed plan ${proposal.id} — ${summary}`,
        content: `Proposed plan ${proposal.id}: ${summary}. It is waiting for the person to approve it; nothing exists in the grove until they do. Approval creates the tree, its sandbox, PLAN.md and a brief per leaf.${earlier.length > 0 ? ` It replaces the ${earlier.length === 1 ? 'plan' : `${earlier.length} plans`} proposed earlier in this conversation, which can no longer be approved.` : ''} Propose again only to change the plan — each proposal replaces the last.`,
      };
    },

    async make_branch({ parsed, caller }): Promise<ToolOutcome> {
      if (!caller.ownerId) return refuse('this run has no owner to branch a tree for');

      const treeId = asString(parsed, 'treeId') ?? asString(parsed, 'tree_id');
      const title = asString(parsed, 'title');
      if (!treeId) return refuse('make_branch needs a treeId — which tree the direction is under');
      if (!title) return refuse('make_branch needs a title — the direction itself in one line');

      const trees = await options.stores.trees.list();
      const tree = trees.find((candidate) => candidate.id === treeId && candidate.ownerId === caller.ownerId);
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
      const branch = branches.find((candidate) => candidate.id === branchId && candidate.ownerId === caller.ownerId);
      if (!branch) return refuse(`no such branch: ${branchId} — make it with make_branch first`);

      const dependencies = asStringList(parsed, 'dependsOn').concat(asStringList(parsed, 'depends_on'));
      if (dependencies.length > 0) {
        const leaves = await options.stores.leaves.list();
        const known = new Set(leaves.filter((leaf) => leaf.ownerId === caller.ownerId).map((leaf) => leaf.id));
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

    async claim_leaf({ parsed, caller, driver }): Promise<ToolOutcome> {
      const needle = asString(parsed, 'leafId') ?? asString(parsed, 'leaf_id');
      if (!needle) return refuse('claim_leaf needs a leafId — the leaf you worked');

      const outcome = asString(parsed, 'result') ?? asString(parsed, 'outcome');
      if (outcome === 'succeeded' || outcome === 'verified' || outcome === 'done') {
        return refuse("you can't claim a leaf as succeeded — the work doesn't get to grade itself. Report 'claimed' with evidence the judge can re-derive (commands with their output, file paths, run ids), or 'failed' with the reason if the work is blocked beyond your power. The judge decides the goal.");
      }
      if (outcome !== 'claimed' && outcome !== 'failed') {
        return refuse("claim_leaf's result is 'claimed' (worked it — here is the evidence) or 'failed' (couldn't — here is why), nothing else");
      }

      const evidence = asString(parsed, 'evidence') ?? asString(parsed, 'evidenceText');
      if (!evidence) {
        return refuse('a claim needs evidence — what you ran and what it showed, with pointers into the workspace the judge can actually look at: commands with their output, file paths, run ids. A claim without it is just the assert-all over again.');
      }
      const findings = asString(parsed, 'findings');
      const reason = asString(parsed, 'reason');
      if (outcome === 'failed' && !reason) return refuse('a failed claim needs a reason — what is blocked, what you tried, and why it is beyond your power');
      const runs = asStringList(parsed, 'runs');

      const leaves = await options.stores.leaves.list();
      const leaf = leaves.find((candidate) => candidate.id === needle && candidate.ownerId === caller.ownerId);
      if (!leaf) return refuse(`no such leaf: ${needle}`);
      if (leaf.status === 'proposed') return refuse(`${leaf.id} is not accepted yet — a proposed leaf has to be admitted into the pass before it can be worked and claimed`);
      if (leaf.status === 'claimed') return refuse(`${leaf.id} is already claimed — the next word comes from the judge, not a second claim`);
      if (leaf.status === 'succeeded' || leaf.status === 'failed' || leaf.status === 'cancelled') {
        return refuse(`${leaf.id} is already settled (${leaf.status}) — there is nothing left to claim`);
      }

      let commit: string | undefined;
      if (outcome === 'claimed' && driver) {
        const head = await worktreeHead(driver);
        if (head.dirty.length > 0) {
          return refuse(`the leaf's worktree has uncommitted changes (${head.dirty.slice(0, 5).join('; ')}${head.dirty.length > 5 ? '; …' : ''}) — commit the work on the leaf's branch first. The judge checks out the commit you claim, so anything not committed does not exist for it.`);
        }
        commit = head.commit;
      }

      const stamp = now();
      const claim: Leaf['claim'] = {
        evidence,
        ...(commit ? { commit } : {}),
        at: stamp,
        ...(findings ? { findings } : {}),
        ...(runs.length > 0 ? { runs } : {}),
      };
      const claimed: Leaf = {
        ...leaf,
        status: outcome === 'failed' ? 'failed' : 'claimed',
        ...((outcome === 'failed' ? reason : findings) ? { findings: (outcome === 'failed' ? reason : findings)! } : {}),
        claim,
        updatedAt: stamp,
      };
      await options.stores.leaves.save(claimed);

      const digest = outcome === 'failed' ? `failed ${leaf.id} — ${reason}` : `claimed ${leaf.id}${commit ? ` at ${commit.slice(0, 12)}` : ''}`;
      return { ok: true, digest, content: `${digest} — evidence on file for the judge (${evidence.length} chars${findings ? ', with findings' : ''})` };
    },

    async settle_leaf({ parsed, caller }): Promise<ToolOutcome> {
      const needle = asString(parsed, 'leafId') ?? asString(parsed, 'leaf_id');
      if (!needle) return refuse('settle_leaf needs a leafId — the claimed leaf to judge');

      const verdict = asString(parsed, 'verdict');
      if (verdict !== 'verified' && verdict !== 'stay-claimed' && verdict !== 'failed') {
        return refuse("a settlement is 'verified' (the evidence demonstrates the goal), 'stay-claimed' (plausible, thin — do not re-run; it waits for more), or 'failed' (the goal was not reached; needs a reason). Nothing else settles a leaf.");
      }
      const note = asString(parsed, 'note') ?? asString(parsed, 'reason');

      const leaves = await options.stores.leaves.list();
      const leaf = leaves.find((candidate) => candidate.id === needle && candidate.ownerId === caller.ownerId);
      if (!leaf) return refuse(`no such leaf: ${needle}`);

      const outcome = settleClaim(leaf, { verdict, note, by: caller.agentSlug, at: now() });
      if ('problem' in outcome) return refuse(outcome.problem);
      await options.stores.leaves.save(outcome.leaf);
      const { digest } = outcome;

      return { ok: true, digest, content: `${digest} — weighed against the claim's evidence (${leaf.claim?.evidence.length ?? 0} chars)` };
    },

    async ready_leaves({ parsed, caller }): Promise<ToolOutcome> {
      const treeId = asString(parsed, 'treeId') ?? asString(parsed, 'tree_id');
      if (!treeId) return refuse('ready_leaves needs a treeId — the tree to schedule');

      const trees = await options.stores.trees.list();
      const tree = trees.find((candidate) => candidate.id === treeId && candidate.ownerId === caller.ownerId);
      if (!tree) return refuse(`no such tree: ${treeId} — check the tree id in the run input`);

      const branches = await options.stores.branches.list();
      const branchOfTree = new Set(branches.filter((branch) => branch.treeId === treeId).map((branch) => branch.id));
      const leaves = (await options.stores.leaves.list()).filter((leaf) => branchOfTree.has(leaf.branchId));
      const byId = new Map(leaves.map((leaf) => [leaf.id, leaf]));

      const openTasksByLeaf = new Map<string, number>();
      if (options.stores.tasks) {
        const tasks = await options.stores.tasks.list();
        for (const task of tasks) {
          if (task.leafId && !SETTLED.includes(task.status) && task.status !== 'proposed') {
            openTasksByLeaf.set(task.leafId, (openTasksByLeaf.get(task.leafId) ?? 0) + 1);
          }
        }
      }

      const ready: { id: string; title: string; body: string; branchId: string; taskCount: number }[] = [];
      const unbroken: { id: string; title: string; branchId: string }[] = [];
      const blocked: { id: string; title: string; waitingOn: string[] }[] = [];
      const notApproved: { id: string; title: string }[] = [];
      const inFlight: { id: string; title: string }[] = [];
      const claimed: { id: string; title: string; body: string; branchId: string; claim?: Leaf['claim'] }[] = [];
      const settled: { id: string; title: string; status: TaskStatus | string }[] = [];
      const parked: { id: string; title: string; review?: string }[] = [];

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
            if (awaitingReview(leaf)) {
              parked.push({ id: leaf.id, title: leaf.title, ...(leaf.review?.reason ? { review: leaf.review.reason } : {}) });
              break;
            }
            claimed.push({ id: leaf.id, title: leaf.title, body: leaf.body ?? '', branchId: leaf.branchId, ...(leaf.claim ? { claim: leaf.claim } : {}) });
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
              ready.push({ id: leaf.id, title: leaf.title, body: leaf.body ?? '', branchId: leaf.branchId, taskCount: openTasksByLeaf.get(leaf.id)! });
            }
            break;
          }
        }
      }

      const digest = `${ready.length} ready, ${blocked.length} blocked, ${unbroken.length} without tasks, ${claimed.length} claimed, ${parked.length} awaiting a person's review, ${inFlight.length} in flight, ${settled.length} settled — tree ${treeId}`;
      const content = JSON.stringify({ treeId, ready, unbroken, blocked, notApproved, claimed, awaitingReview: parked, inFlight, settled }, null, 2);
      return { ok: true, digest, content };
    },
  };
}