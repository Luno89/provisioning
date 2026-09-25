import { Router, type Request } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import { ownedBy } from '../lib/ownership.js';
import { rollupProjectStatus, deploymentForProject } from '../lib/project-status.js';
import { summariseDelivery } from '../lib/branch-delivery.js';
import { usableAcceptancePlan, type AcceptanceCheck } from '../lib/acceptance.js';
import { hollowChecks, explainHollow } from '../lib/acceptance-validation.js';
import { blockedBy } from '../lib/leaves.js';
import type { Tree } from '../lib/trees.js';
import type { Leaf, Branch } from '../lib/leaves.js';
import type { Database } from '../lib/db-interface.js';
import type { GroveDeletionService } from '../services/GroveDeletionService.js';

export interface BranchesRouterDeps {
  db: Database;
  deletion: Pick<GroveDeletionService, 'deleteBranch'>;
}

const idOf = (req: Request): string => String(req.params.id ?? '');

const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

export function branchesRouter(deps: BranchesRouterDeps): Router {
  const { db } = deps;
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
    const outcome = await deps.deletion.deleteBranch(userOf(req).id, idOf(req));
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    res.json({ success: true, stoppedRun: outcome.value.stoppedRun, deleted: outcome.value.scope });
  }));

  return router;
}
