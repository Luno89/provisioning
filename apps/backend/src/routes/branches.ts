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

export interface BranchesRouterDeps {
  db: Database;
  temporalBridge: TemporalBridge;
}

const idOf = (req: Request): string => String(req.params.id ?? '');

const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

export function branchesRouter(deps: BranchesRouterDeps): Router {
  const { db, temporalBridge } = deps;
  const router = Router();

  const ownedTrees = async (userId: string) => ownedBy(await db.getTrees(), userId);
  const ownedBranches = async (userId: string) => ownedBy(await db.getBranches(), userId);
  const ownedLeaves = async (userId: string) => ownedBy(await db.getLeaves(), userId);

  router.get('/', asyncRoute(async (req, res) => {
    const branches = await ownedBranches(userOf(req).id);
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
    res.json(withDelivery.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  }));

  router.post('/', asyncRoute(async (req, res) => {
    const user = userOf(req);
    const now = new Date().toISOString();
    const requestedTree = typeof req.body?.treeId === 'string' ? req.body.treeId : '';
    const tree = requestedTree
      ? (await ownedTrees(user.id)).find((t) => t.id === requestedTree)
      : undefined;
    if (requestedTree && !tree) return res.status(404).json({ error: 'Tree not found' });

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
    for (const leaf of (await ownedLeaves(user.id)).filter((l) => l.branchId === branch.id)) {
      await temporalBridge?.signalLeaf(leaf.id, 'cancelLeaf');
      await db.deleteLeaf(leaf.id);
    }
    await db.deleteBranch(branch.id);
    res.json({ success: true });
  }));

  return router;
}
