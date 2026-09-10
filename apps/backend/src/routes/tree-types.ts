import { Router, type Request } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import { ownedBy } from '../lib/ownership.js';
import { validateTreeType } from '../lib/tree-types.js';
import type { Database } from '../lib/db-interface.js';

export interface TreeTypesRouterDeps {
  db: Pick<Database, 'getTreeTypes' | 'saveTreeType' | 'deleteTreeType' | 'getTrees' | 'getWorkspaceImages'>;
}

const idOf = (req: Request): string => String(req.params.id ?? '');

const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

export function treeTypesRouter(deps: TreeTypesRouterDeps): Router {
  const { db } = deps;
  const router = Router();

  const ownedTrees = async (userId: string) => ownedBy(await db.getTrees(), userId);

  router.get('/', asyncRoute(async (req, res) => {
    const userId = userOf(req).id;
    const all = await db.getTreeTypes(userId);
    // A user's own row wins over the shipped one at the same id — getTreeTypes(ownerId) returns
    // both (it's an owner-scoped filter, not a merge), same as resolveTreeType() already handles
    // for a single lookup. Without this, editing any built-in type makes it appear twice here.
    const byId = new Map<string, typeof all[number]>();
    for (const t of all) {
      const existing = byId.get(t.id);
      if (!existing || (existing.ownerId === undefined && t.ownerId === userId)) byId.set(t.id, t);
    }
    res.json([...byId.values()]);
  }));

  router.put('/:id', asyncRoute(async (req, res) => {
    const userId = userOf(req).id;
    const candidate = { ...(req.body ?? {}), id: idOf(req), ownerId: userId };

    const invalid = validateTreeType(await db.getWorkspaceImages(userId), candidate);
    if (invalid) return res.status(400).json({ error: invalid });

    await db.saveTreeType(candidate);
    res.json(candidate);
  }));

  router.delete('/:id', asyncRoute(async (req, res) => {
    const userId = userOf(req).id;
    const inUse = (await ownedTrees(userId)).filter((t) => t.type === idOf(req));
    if (inUse.length) {
      return res.status(409).json({
        error: `${inUse.length} tree(s) still use this type: ${inUse.map((t) => t.name).join(', ')}.`,
      });
    }

    await db.deleteTreeType(idOf(req), userId);
    res.json({ deleted: idOf(req) });
  }));

  return router;
}
