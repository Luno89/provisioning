import { Router, type Request } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import { ownedBy } from '../lib/ownership.js';
import { validateTreeType } from '../lib/tree-types.js';
import type { Database } from '../lib/db-interface.js';

export interface TreeTypesRouterDeps {
  db: Pick<Database, 'getTreeTypes' | 'saveTreeType' | 'deleteTreeType' | 'getTrees'>;
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
    res.json(await db.getTreeTypes(userId));
  }));

  router.put('/:id', asyncRoute(async (req, res) => {
    const userId = userOf(req).id;
    const candidate = { ...(req.body ?? {}), id: idOf(req), ownerId: userId };

    const invalid = validateTreeType(candidate);
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
