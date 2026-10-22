import { Router, type Request } from 'express';
import { asyncRoute } from '../../platform/middleware/async-route.js';
import { ownedBy } from '../../platform/lib/ownership.js';
import { agentProblem, validateTreeType } from '../lib/tree-types.js';
import type { Database } from '../../platform/lib/db-interface.js';

export interface TreeTypesRouterDeps {
  releaseProblem?: ((ownerId: string, how: unknown) => Promise<string | null>) | undefined;
  db: Pick<Database, 'projects' | 'getWorkspaceImages'>;
  agents: (ownerId: string) => Promise<string[]>;
  describe?: ((ownerId: string, typeId: string) => Promise<string | undefined>) | undefined;
}

const idOf = (req: Request): string => String(req.params.id ?? '');

const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

export function treeTypesRouter(deps: TreeTypesRouterDeps): Router {
  const { db } = deps;
  const router = Router();

  const ownedTrees = async (userId: string) => ownedBy(await db.projects.getTrees(), userId);

  router.get('/', asyncRoute(async (req, res) => {
    const userId = userOf(req).id;
    const all = await db.projects.getTreeTypes(userId);
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

    const invalid = validateTreeType(await db.getWorkspaceImages(userId), candidate)
      ?? agentProblem(candidate.agent, await deps.agents(userId))
      ?? (candidate.release !== undefined && deps.releaseProblem ? await deps.releaseProblem(userId, candidate.release) : null);
    if (invalid) return res.status(400).json({ error: invalid });

    await db.projects.saveTreeType(candidate);
    res.json(candidate);
  }));

  router.get('/:id/description', asyncRoute(async (req, res) => {
    if (!deps.describe) return res.status(404).json({ error: 'Tree types are not described here' });
    const text = await deps.describe(userOf(req).id, idOf(req));
    if (!text) return res.status(404).json({ error: `There is no tree type "${idOf(req)}".` });
    res.json({ text });
  }));

  router.delete('/:id', asyncRoute(async (req, res) => {
    const userId = userOf(req).id;
    const shippedStays = (await db.projects.getTreeTypes(userId)).some((type) => type.id === idOf(req) && type.ownerId === undefined);
    const inUse = shippedStays ? [] : (await ownedTrees(userId)).filter((t) => t.type === idOf(req));
    if (inUse.length) {
      return res.status(409).json({
        error: `${inUse.length} tree(s) still use this type: ${inUse.map((t) => t.name).join(', ')}.`,
      });
    }

    await db.projects.deleteTreeType(idOf(req), userId);
    res.json({ deleted: idOf(req) });
  }));

  return router;
}
