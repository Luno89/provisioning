import { Router, type Request } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import { ownedBy } from '../lib/ownership.js';
import { v4 as uuidv4 } from 'uuid';
import { rollupProjectStatus, deploymentForProject } from '../lib/project-status.js';
import { summariseDelivery } from '../lib/branch-delivery.js';
import { usableAcceptancePlan, type AcceptanceCheck } from '../lib/acceptance.js';
import { hollowChecks, explainHollow } from '../lib/acceptance-validation.js';
import { inheritedAcceptance } from '../lib/acceptance-inherit.js';
import { blockedBy } from '../lib/leaves.js';
import type { Tree } from '../lib/trees.js';
import type { Leaf, Branch } from '../lib/leaves.js';
import type { Database } from '../lib/db-interface.js';
import type { TemporalBridge } from '../services/TemporalBridge.js';

/**
 * Branches: one planning conversation each.
 *
 * A branch is where Koala and the user agree what the leaves should be, so deleting one has to
 * decide what happens to the work it produced — see the delete route.
 */
export interface BranchesRouterDeps {
  db: Database;
  temporalBridge: TemporalBridge;
}

/** The `:id` from the path, narrowed once — Express types `req.params` loosely inside asyncRoute. */
const idOf = (req: Request): string => String(req.params.id ?? '');

/** The user `requireAuth` put on the request. */
const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

export function branchesRouter(deps: BranchesRouterDeps): Router {
  const { db, temporalBridge } = deps;
  const router = Router();

  /**
   * Ownership filters, from `lib/ownership.ts`.
   *
   * These were seven near-identical closures in index.ts — `ownedTrees`, `ownedBranches`,
   * `ownedLeaves`, `ownedPersonas` and friends, each one line, each one line that could be
   * forgotten on the eighth collection.
   */
  const ownedTrees = async (userId: string) => ownedBy(await db.getTrees(), userId);
  const ownedBranches = async (userId: string) => ownedBy(await db.getBranches(), userId);
  const ownedLeaves = async (userId: string) => ownedBy(await db.getLeaves(), userId);

  router.get('/', asyncRoute(async (req, res) => {
    const branches = await ownedBranches(userOf(req).id);
    /**
     * Each branch carries how far the request it represents actually got.
     *
     * Derived here from records the platform already writes — leaves, pipeline runs, deployments —
     * so the branch view and the Projects list cannot disagree, and so nothing has to read git to
     * answer it. The project rollup is looked up per branch through the leaves' projectId, since a
     * request's repo is created lazily by its first leaf.
     */
    const [allLeaves, projects, runs, deployments] = await Promise.all([
      db.getLeaves(), db.getProjects(), db.getPipelineRuns(), db.getDeployments(),
    ]);
    const withDelivery = branches.map((b) => {
      const projectId = allLeaves.find((l: any) => l.branchId === b.id && l.projectId)?.projectId;
      const project = projectId ? projects.find((p: any) => p.id === projectId) : undefined;
      const rollup = project
        ? rollupProjectStatus(project, runs, deploymentForProject(project, deployments))
        : undefined;
      return {
        ...b,
        delivery: summariseDelivery(b, allLeaves, rollup),
        ...(project ? { projectName: project.name } : {}),
      };
    });
    // Newest first: a conversation you just had is the one you want.
    res.json(withDelivery.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  }));

  router.post('/', asyncRoute(async (req, res) => {
    const user = userOf(req);
    const now = new Date().toISOString();
    /**
     * Validated against the caller's own trees, not merely typechecked.
     *
     * A treeId is untrusted input, and an unchecked one would either file this conversation under
     * someone else's tree or under nothing at all — the dangling reference the delete route goes
     * out of its way to avoid creating.
     */
    const requestedTree = typeof req.body?.treeId === 'string' ? req.body.treeId : '';
    const tree = requestedTree
      ? (await ownedTrees(user.id)).find((t) => t.id === requestedTree)
      : undefined;
    if (requestedTree && !tree) return res.status(404).json({ error: 'Tree not found' });

    /**
     * A follow-up branch starts with its tree's acceptance plan.
     *
     * Nothing may be accepted on a branch without one, and only the planner ever set one — during
     * planning, on the first branch. So every follow-up was born unacceptable, and the refusal was
     * swallowed by the UI, which is what "I can't click accept" turned out to be. A default, not a
     * decision: it is editable, and a planner that sets its own replaces it.
     */
    const inherited = tree ? inheritedAcceptance(tree.id, await ownedBranches(user.id)) : [];
    if (inherited.length) {
      console.log(`[branches] new branch inherits ${inherited.length} acceptance check(s) from tree ${tree!.id.slice(0, 8)}`);
    }

    const branch: Branch = {
      id: uuidv4(),
      ownerId: user.id,
      title: typeof req.body?.title === 'string' && req.body.title.trim() ? req.body.title.trim() : 'New branch',
      messages: [],
      ...(tree ? { treeId: tree.id } : {}),
      createdAt: now,
      updatedAt: now,
          ...(inherited.length ? { acceptance: inherited } : {}),
};
    await db.saveBranch(branch);
    res.status(201).json(branch);
  }));

  router.patch('/:id', asyncRoute(async (req, res) => {
    const user = userOf(req);
    const branch = (await ownedBranches(user.id)).find((b) => b.id === idOf(req));
    if (!branch) return res.status(404).json({ error: 'Branch not found' });
    const { title, treeId, acceptance } = req.body ?? {};
    const renaming = typeof title === 'string' && title.trim();
    const refiling = typeof treeId === 'string';
    const reChecking = acceptance !== undefined;
    if (!renaming && !refiling && !reChecking) {
      return res.status(400).json({ error: 'title, treeId or acceptance is required' });
    }

    /**
     * Setting the acceptance plan by hand.
     *
     * Without this the only way to get one was to persuade the planner to call `set_acceptance`,
     * which left a person with no way forward on a branch it had not — and no way to correct one
     * it got wrong.
     *
     * Held to the SAME two rules the tool is: the checks must be usable, and they must be able to
     * fail. A hand-written `echo ok` would satisfy the accept gate and prove nothing, which is the
     * hollow green this gate exists to prevent — it does not matter who typed it.
     */
    let checks: { acceptance?: AcceptanceCheck[] } = {};
    if (reChecking) {
      const plan = usableAcceptancePlan(acceptance);
      if (plan.length === 0) {
        return res.status(400).json({
          error: 'No usable checks. Each needs a name and a single-line command, with no command '
            + 'substitution, backgrounding, or chaining beyond `&&`.',
        });
      }
      const hollow = hollowChecks(plan);
      if (hollow.length) return res.status(400).json({ error: explainHollow(hollow) });
      checks = { acceptance: plan };
    }

    // An empty treeId un-files the conversation rather than being rejected — moving something out
    // of a tree has to be as possible as moving it in.
    let filed: { treeId?: string } = {};
    if (refiling && treeId) {
      const target = (await ownedTrees(user.id)).find((t) => t.id === treeId);
      if (!target) return res.status(404).json({ error: 'Tree not found' });
      filed = { treeId: target.id };
    }
    const { treeId: _current, ...withoutTree } = branch;
    const updated: Branch = {
      ...(refiling ? withoutTree : branch),
      ...filed,
      ...(renaming ? { title: title.trim().slice(0, 200) } : {}),
      ...checks,
      updatedAt: new Date().toISOString(),
    };
    await db.saveBranch(updated);
    res.json(updated);
  }));

  router.delete('/:id', asyncRoute(async (req, res) => {
    const user = userOf(req);
    const branch = (await ownedBranches(user.id)).find((b) => b.id === idOf(req));
    if (!branch) return res.status(404).json({ error: 'Branch not found' });
    // Its leaves go too. A leaf without its branch is unreachable in the tree and would still
    // count against nothing — an orphan nobody can see or delete.
    for (const leaf of (await ownedLeaves(user.id)).filter((l) => l.branchId === branch.id)) {
      await temporalBridge?.signalLeaf(leaf.id, 'cancelLeaf');
      await db.deleteLeaf(leaf.id);
    }
    await db.deleteBranch(branch.id);
    res.json({ success: true });
  }));



  return router;
}
