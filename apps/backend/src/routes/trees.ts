import { Router, type Request } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import { ownedBy } from '../lib/ownership.js';
import { v4 as uuidv4 } from 'uuid';
import { resolveTreeType } from '../lib/tree-types.js';
import { normaliseTreeInput } from '../lib/trees.js';
import type { Tree } from '../lib/trees.js';
import type { Database } from '../lib/db-interface.js';
import type { TreeWorkspaces } from '../engine-host/sandboxes/tree-workspaces.js';
import type { GroveDeletionService } from '../services/GroveDeletionService.js';
import type { GroveRunService } from '../services/GroveRunService.js';

export interface TreesRouterDeps {
  db: Database;
  workspaces: Pick<TreeWorkspaces, 'state' | 'release'>;
  runs: Pick<GroveRunService, 'run' | 'status' | 'stop'>;
  deletion: Pick<GroveDeletionService, 'deleteTree'>;
  landings?: { pullRequests(ownerId: string, treeId: string): Promise<TreePullRequest[]> } | undefined;
}

export interface TreePullRequest {
  number: number;
  title: string;
  head: string;
  base: string;
  state: string;
  merged: boolean;
}

const idOf = (req: Request): string => String(req.params.id ?? '');

const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

export function treesRouter(deps: TreesRouterDeps): Router {
  const { db, workspaces, runs } = deps;
  const router = Router();

  const ownedTrees = async (userId: string) => ownedBy(await db.getTrees(), userId);

  router.get('/', asyncRoute(async (req, res) => {
    const trees = await ownedTrees(userOf(req).id);
    const branches = ownedBy(await db.getBranches(), userOf(req).id);
    res.json(
      [...trees]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((t) => ({ ...t, branchCount: branches.filter((b) => b.treeId === t.id).length })),
    );
  }));

  router.post('/', asyncRoute(async (req, res) => {
    const userId = userOf(req).id;
    const input = normaliseTreeInput(req.body ?? {});
    if (!input) return res.status(400).json({ error: 'name and type are required' });

    const typeSpec = await resolveTreeType(db, userId, input.type);
    if (!typeSpec) {
      const available = await db.getTreeTypes(userId);
      return res.status(400).json({
        error: `There is no project type "${input.type}".`,
        available: available.map((t) => ({ id: t.id, label: t.label })),
      });
    }

    const now = new Date().toISOString();
    const tree: Tree = {
      id: uuidv4(),
      ownerId: userId,
      ...input,
      projectIds: [],
      createdAt: now,
      updatedAt: now,
    };
    await db.saveTree(tree);
    res.status(201).json(tree);
  }));

  router.get('/:id/run', asyncRoute(async (req, res) => {
    const outcome = await runs.status(userOf(req).id, idOf(req));
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    res.json(outcome.value);
  }));

  router.post('/:id/run/stop', asyncRoute(async (req, res) => {
    const outcome = await runs.stop(userOf(req).id, idOf(req));
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    res.status(202).json(outcome.value);
  }));

  router.post('/:id/run', asyncRoute(async (req, res) => {
    const outcome = await runs.run(userOf(req).id, idOf(req));
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    res.status(202).json(outcome.value);
  }));

  router.get('/:id/workspace', asyncRoute(async (req, res) => {
    const tree = (await ownedTrees(userOf(req).id)).find((t) => t.id === idOf(req));
    if (!tree) return res.status(404).json({ error: 'Tree not found' });
    res.json({ state: await workspaces.state(tree.id) });
  }));

  router.get('/:id/pull-requests', asyncRoute(async (req, res) => {
    const tree = (await ownedTrees(userOf(req).id)).find((t) => t.id === idOf(req));
    if (!tree) return res.status(404).json({ error: 'Tree not found' });
    if (!deps.landings) return res.json({ pullRequests: [] });
    res.json({ pullRequests: await deps.landings.pullRequests(userOf(req).id, tree.id) });
  }));

  router.delete('/:id/workspace', asyncRoute(async (req, res) => {
    const tree = (await ownedTrees(userOf(req).id)).find((t) => t.id === idOf(req));
    if (!tree) return res.status(404).json({ error: 'Tree not found' });
    await workspaces.release(tree.id, userOf(req).id);
    res.json({ state: 'none' });
  }));

  router.delete('/:id', asyncRoute(async (req, res) => {
    const outcome = await deps.deletion.deleteTree(userOf(req).id, idOf(req));
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    res.json({ success: true, stoppedRun: outcome.value.stoppedRun, deleted: outcome.value.scope });
  }));

  return router;
}
