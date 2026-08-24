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

/**
 * Trees: one per project, holding the branches that plan it.
 *
 * ── NO SERVICE, AND WHY THAT IS THE RIGHT ANSWER HERE ──
 * These routes read and write records and call `lib/` for anything that thinks. A service would be
 * a class whose every method was one `db` call with an ownership filter in front of it — see B5:
 * something becomes a service when it holds state beyond a request, owns a resource, or is the sole
 * writer of a collection. None of that is true here, so the ownership filter is `ownedBy` from
 * lib/ownership.ts and the rest is the route.
 */
export interface TreesRouterDeps {
  db: Database;
  temporalBridge: TemporalBridge;
}

/** The `:id` from the path, narrowed once — Express types `req.params` loosely inside asyncRoute. */
const idOf = (req: Request): string => String(req.params.id ?? '');

/** The user `requireAuth` put on the request. */
const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

export function treesRouter(deps: TreesRouterDeps): Router {
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
    const trees = await ownedTrees(userOf(req).id);
    const branches = await ownedBranches(userOf(req).id);
    // Branch count comes back with the tree: a tree with no conversations in it is the thing you
    // most want to notice, and asking for it separately means the list cannot show it at all.
    res.json(
      [...trees]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((t) => ({ ...t, branchCount: branches.filter((b) => b.treeId === t.id).length })),
    );
  }));

  /**
   * One tree's board: its leaves across every conversation, plus the rollup.
   *
   * Served assembled rather than letting the client join leaves to branches to trees itself — the
   * blocked/queued split and the verified/claimed split are judgements (lib/tree-board.ts), and a
   * component that recomputes them is a component that will eventually disagree with the server.
   */
  router.get('/:id/board', asyncRoute(async (req, res) => {
    const user = userOf(req);
    const tree = (await ownedTrees(user.id)).find((t) => t.id === idOf(req));
    if (!tree) return res.status(404).json({ error: 'Tree not found' });

    const branches = (await ownedBranches(user.id)).filter((b) => b.treeId === tree.id);
    const branchIds = new Set(branches.map((b) => b.id));
    const all = await ownedLeaves(user.id);
    const mine = all.filter((l) => branchIds.has(l.branchId));

    // blockedBy needs the WHOLE list: a dependency may sit on another branch of the same tree.
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
      /**
       * Only what the board can show.
       *
       * `columnFor` returns nothing for a cancelled leaf — it is neither done nor outstanding, so
       * counting it either way would misstate the total. Sending it anyway would mean a payload
       * that disagrees with the board it feeds, and the next person to add a count would take the
       * array length.
       */
      leaves: mine.filter((l) => columnFor(l, isBlocked(l))).map((l) => ({
        id: l.id,
        branchId: l.branchId,
        title: l.title,
        status: l.status,
        column: columnFor(l, isBlocked(l)),
        personaId: l.personaId,
        verified: l.verified,
        merged: l.merged,
        tokens: l.usage?.tokens ?? 0,
        attempts: l.attempts?.length ?? 0,
        // Named, not just counted: "waiting on something" is far less useful than "waiting on the
        // transport leaf", and the board has room for the name.
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

    /**
     * The type must be one this owner HAS.
     *
     * `normaliseTreeInput` used to check this against a compile-time union. Types are owned records
     * now, so shape is all it can answer and existence is a question for the store — checked here,
     * where the owner is known. Refused rather than defaulted: the type decides the workspace image,
     * the starter files and what finishing means.
     */
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
    // Spread the stored tree rather than naming its fields — saveTree is a full replace, and a
    // rename that silently dropped projectIds is exactly the shape of bug this codebase keeps
    // producing. The type is deliberately not editable: it decides how the work is verified.
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
    /**
     * The conversations survive; they are only un-scoped.
     *
     * Deleting a tree is a filing decision, not a decision to destroy work — and a branch left
     * pointing at a tree that no longer exists is the orphan this codebase just spent a session
     * chasing. Its repositories are left alone too: a repo can outlive the tree that organised it,
     * and deleting one from here would be irreversible.
     */
    for (const branch of (await ownedBranches(user.id)).filter((b) => b.treeId === tree.id)) {
      const { treeId: _dropped, ...rest } = branch;
      await db.saveBranch(rest as Branch);
    }
    await db.deleteTree(tree.id);
    res.json({ success: true });
  }));

  return router;
}
