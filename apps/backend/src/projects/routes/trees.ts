import { Router, type Request } from 'express';
import { asyncRoute } from '../../platform/middleware/async-route.js';
import { ownedBy } from '../../platform/lib/ownership.js';
import { v4 as uuidv4 } from 'uuid';
import { resolveTreeType, versionForNewTree } from '../lib/tree-types.js';
import { normaliseTreeInput } from '../lib/trees.js';
import type { Tree } from '../lib/trees.js';
import type { Database } from '../../platform/lib/db-interface.js';
import type { TreeWorkspaces } from '../../engine-host/sandboxes/tree-workspaces.js';
import type { GroveDeletionService } from '../services/GroveDeletionService.js';
import type { GroveRunService } from '../services/GroveRunService.js';
import type { TreeHomeService } from '../services/TreeHomeService.js';
import type { GroveOrderService } from '../services/GroveOrderService.js';
import type { TreeWorkspaceService } from '../services/TreeWorkspaceService.js';
import type { TreeModelsService } from '../../models/services/TreeModelsService.js';

export interface TreesRouterDeps {
  db: Database;
  workspaces: Pick<TreeWorkspaces, 'state' | 'release'>;
  runs: Pick<GroveRunService, 'run' | 'status' | 'stop'>;
  deletion: Pick<GroveDeletionService, 'deleteTree'>;
  order: Pick<GroveOrderService, 'orderFeatures'>;
  home: Pick<TreeHomeService, 'home'>;
  landings?: { pullRequests(ownerId: string, treeId: string): Promise<TreePullRequest[]> } | undefined;
  workspaceFile?: Pick<TreeWorkspaceService, 'view' | 'save'> | undefined;
  models: Pick<TreeModelsService, 'view' | 'set'>;
  changed?: ((ownerId: string) => void) | undefined;
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

  const ownedTrees = async (userId: string) => ownedBy(await db.projects.getTrees(), userId);

  router.get('/', asyncRoute(async (req, res) => {
    const trees = await ownedTrees(userOf(req).id);
    const branches = ownedBy(await db.projects.getBranches(), userOf(req).id);
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

    const typeSpec = await resolveTreeType(db.projects, userId, input.type);
    if (!typeSpec) {
      const available = await db.projects.getTreeTypes(userId);
      return res.status(400).json({
        error: `There is no project type "${input.type}".`,
        available: available.map((t) => ({ id: t.id, label: t.label })),
      });
    }

    const version = versionForNewTree(typeSpec, input.version);
    if (!version.ok) return res.status(400).json({ error: version.error });

    const now = new Date().toISOString();
    const { version: _asked, ...rest } = input;
    const tree: Tree = {
      id: uuidv4(),
      ownerId: userId,
      ...rest,
      ...(version.version ? { version: version.version } : {}),
      projectIds: [],
      createdAt: now,
      updatedAt: now,
    };
    await db.projects.saveTree(tree);
    try {
      const homed = await deps.home.home(tree);
      deps.changed?.(userId);
      res.status(201).json(homed);
    } catch (err) {
      await db.projects.deleteTree(tree.id);
      res.status(502).json({ error: `The tree could not be given its project, so it was not made: ${(err as Error).message}` });
    }
  }));

  router.get('/:id/run', asyncRoute(async (req, res) => {
    const outcome = await runs.status(userOf(req).id, idOf(req));
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    res.json(outcome.value);
  }));

  router.get('/:id/models', asyncRoute(async (req, res) => {
    const outcome = await deps.models.view(userOf(req).id, idOf(req));
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    res.json(outcome.value);
  }));

  router.put('/:id/models', asyncRoute(async (req, res) => {
    const outcome = await deps.models.set(userOf(req).id, idOf(req), req.body);
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    res.json(outcome.value);
  }));

  router.put('/:id/order', asyncRoute(async (req, res) => {
    const outcome = await deps.order.orderFeatures(userOf(req).id, idOf(req), req.body?.branchIds);
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

  router.get('/:id/workspace-file', asyncRoute(async (req, res) => {
    if (!deps.workspaceFile) return res.status(503).json({ error: 'This server cannot read a tree\'s workspace file' });
    const view = await deps.workspaceFile.view(userOf(req).id, idOf(req));
    if (!view) return res.status(404).json({ error: 'Tree not found' });
    res.json(view);
  }));

  router.put('/:id/workspace-file', asyncRoute(async (req, res) => {
    if (!deps.workspaceFile) return res.status(503).json({ error: 'This server cannot save a tree\'s workspace file' });
    const body = (req.body ?? {}) as { file?: unknown; said?: unknown };
    const said = typeof body.said === 'string' && body.said.trim() ? body.said.trim() : 'edited in the Studio';
    const saved = await deps.workspaceFile.save(userOf(req).id, idOf(req), body.file, said);
    if (!saved.ok) return res.status(saved.status).json({ error: saved.why });
    res.json({ ...saved.view, committed: saved.committed, ...(saved.build ? { build: saved.build } : {}) });
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
    deps.changed?.(userOf(req).id);
    res.json({ success: true, stoppedRun: outcome.value.stoppedRun, deleted: outcome.value.scope });
  }));

  return router;
}
