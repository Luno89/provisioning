import { Router, type Request } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import { ownedBy } from '../lib/ownership.js';
import { seedTreeTypes, validateTreeType } from '../lib/tree-types.js';
import type { Database } from '../lib/db-interface.js';

/**
 * The project-type catalogue: what kinds of tree a user can create.
 *
 * ── SEEDED ON READ ──
 * `GET /` seeds before it lists, the same shape personas use, so a user who predates a type still
 * gets it. That is why the list route has a write in it — and why the seed only ever ADDS, since a
 * migration that overwrites a deliberate setting is worse than one that never ran.
 */
export interface TreeTypesRouterDeps {
  db: Pick<Database, 'getTreeTypes' | 'saveTreeType' | 'deleteTreeType' | 'getTrees'>;
}

/** The `:id` from the path, narrowed once — Express types `req.params` loosely inside asyncRoute. */
const idOf = (req: Request): string => String(req.params.id ?? '');

/** The user `requireAuth` put on the request. */
const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

export function treeTypesRouter(deps: TreeTypesRouterDeps): Router {
  const { db } = deps;
  const router = Router();

  /** Ownership filter, from `lib/ownership.ts`. */
  const ownedTrees = async (userId: string) => ownedBy(await db.getTrees(), userId);

  /**
   * The type catalogue, served rather than duplicated in the UI.
   *
   * The picker needs the label, the summary and what done means for each type. Copying that table
   * into the frontend would give two lists to keep in step, which is the failure this codebase has
   * already had with leaf columns and with cluster providers.
   */
  router.get('/', asyncRoute(async (req, res) => {
    const userId = userOf(req).id;
    // Seeded on read: the same shape as personas, so a user who predates a type still gets it.
    await seedTreeTypes(db, userId).catch((err: Error) => console.warn(`[tree-types] could not seed: ${err.message}`));
    res.json(await db.getTreeTypes(userId));
  }));

  /**
   * Create or edit a project type.
   *
   * The point of the whole record: adding a project type is a form rather than a deploy. Validated
   * against `validateTreeType` for the reason every other write here is — a bad record fails later,
   * somewhere further from the mistake.
   */
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
    /**
     * Refused while anything still uses it.
     *
     * A tree whose type has been deleted resolves nothing, and `resolveTreeType` deliberately does
     * not substitute a default — so the tree would build no workspace at all. Better to say why.
     */
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
