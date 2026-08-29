import { Router, type Request } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import { ownedBy } from '../lib/ownership.js';
import { v4 as uuidv4 } from 'uuid';
import { seedTreeTypes, resolveTreeType } from '../lib/tree-types.js';
import { normaliseTreeInput } from '../lib/trees.js';
import { columnFor, changedSince, rollup } from '../lib/tree-board.js';
import { blockedBy } from '../lib/leaves.js';
import { specsToSeed } from '../lib/app-spec.js';
import type { Tree } from '../lib/trees.js';
import type { Leaf, Branch } from '../lib/leaves.js';
import type { Database } from '../lib/db-interface.js';
import type { TemporalBridge } from '../services/TemporalBridge.js';

export interface TreesRouterDeps {
  db: Database;
  temporalBridge: TemporalBridge;
}

const idOf = (req: Request): string => String(req.params.id ?? '');

const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

export function treesRouter(deps: TreesRouterDeps): Router {
  const { db, temporalBridge } = deps;
  const router = Router();

  const ownedTrees = async (userId: string) => ownedBy(await db.getTrees(), userId);
  const ownedBranches = async (userId: string) => ownedBy(await db.getBranches(), userId);
  const ownedLeaves = async (userId: string) => ownedBy(await db.getLeaves(), userId);

  router.get('/', asyncRoute(async (req, res) => {
    const trees = await ownedTrees(userOf(req).id);
    const branches = await ownedBranches(userOf(req).id);
    res.json(
      [...trees]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((t) => ({ ...t, branchCount: branches.filter((b) => b.treeId === t.id).length })),
    );
  }));

  router.get('/:id/board', asyncRoute(async (req, res) => {
    const user = userOf(req);
    const tree = (await ownedTrees(user.id)).find((t) => t.id === idOf(req));
    if (!tree) return res.status(404).json({ error: 'Tree not found' });

    const branches = (await ownedBranches(user.id)).filter((b) => b.treeId === tree.id);
    const branchIds = new Set(branches.map((b) => b.id));
    const all = await ownedLeaves(user.id);
    const mine = all.filter((l) => branchIds.has(l.branchId));

    const isBlocked = (leaf: Leaf) => blockedBy(leaf, all).length > 0;

    const since = typeof req.query.since === 'string' ? req.query.since : undefined;
    const projects = await db.getProjects();

    res.json({
      tree,
      rollup: rollup(mine, isBlocked),
      changed: changedSince(mine, since),
      repos: (tree.projectIds ?? [])
        .map((id) => projects.find((p) => p.id === id))
        .filter(Boolean)
        .map((p) => ({ id: p!.id, name: p!.name, owner: p!.giteaOwner, repo: p!.giteaRepo })),
      branches: branches.map((b) => ({
        id: b.id,
        title: b.title,
        acceptanceOutcome: b.acceptanceOutcome,
        updatedAt: b.updatedAt,
      })),
      leaves: mine.filter((l) => columnFor(l, isBlocked(l))).map((l) => ({
        id: l.id,
        branchId: l.branchId,
        title: l.title,
        status: l.status,
        column: columnFor(l, isBlocked(l)),
        packId: l.packId,
        verified: l.verified,
        merged: l.merged,
        tokens: l.usage?.tokens ?? 0,
        attempts: l.attempts?.length ?? 0,
        waitingOn: blockedBy(l, all).map((w) => ({ id: w.id, title: w.title })),
        outputBranch: l.outputBranch,
        updatedAt: l.updatedAt,
      })),
    });
  }));

  router.post('/', asyncRoute(async (req, res) => {
    const userId = userOf(req).id;
    const input = normaliseTreeInput(req.body ?? {});
    if (!input) return res.status(400).json({ error: 'name and type are required' });

    await seedTreeTypes(db, userId).catch(() => undefined);
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

  router.patch('/:id', asyncRoute(async (req, res) => {
    const tree = (await ownedTrees(userOf(req).id)).find((t) => t.id === idOf(req));
    if (!tree) return res.status(404).json({ error: 'Tree not found' });
    const { name, goal } = req.body ?? {};
    const updated: Tree = {
      ...tree,
      ...(typeof name === 'string' && name.trim() ? { name: name.trim().slice(0, 120) } : {}),
      ...(typeof goal === 'string' ? { goal: goal.trim().slice(0, 2000) } : {}),
      updatedAt: new Date().toISOString(),
    };
    await db.saveTree(updated);
    res.json(updated);
  }));

  router.delete('/:id', asyncRoute(async (req, res) => {
    const user = userOf(req);
    const tree = (await ownedTrees(user.id)).find((t) => t.id === idOf(req));
    if (!tree) return res.status(404).json({ error: 'Tree not found' });
    for (const branch of (await ownedBranches(user.id)).filter((b) => b.treeId === tree.id)) {
      const { treeId: _dropped, ...rest } = branch;
      await db.saveBranch(rest as Branch);
    }
    await db.deleteTree(tree.id);
    res.json({ success: true });
  }));

  return router;
}
