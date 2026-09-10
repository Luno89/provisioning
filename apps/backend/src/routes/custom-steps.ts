import { Router, type Request } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { asyncRoute } from '../middleware/async-route.js';
import { validateCustomStepDefinition, type CustomStepDefinition } from '../lib/custom-steps.js';
import { someRecipeLeaf } from '../lib/tree-types.js';
import type { Database } from '../lib/db-interface.js';

export interface CustomStepsRouterDeps {
  db: Pick<Database, 'getCustomStepDefinitions' | 'saveCustomStepDefinition' | 'deleteCustomStepDefinition' | 'getTreeTypes'>;
}

const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

export function customStepsRouter(deps: CustomStepsRouterDeps): Router {
  const { db } = deps;
  const router = Router();

  router.get('/', asyncRoute(async (req, res) => {
    res.json(await db.getCustomStepDefinitions(userOf(req).id));
  }));

  router.post('/', asyncRoute(async (req, res) => {
    const userId = userOf(req).id;
    const now = new Date().toISOString();
    const candidate: CustomStepDefinition = {
      ...(req.body ?? {}),
      id: (req.body?.id?.trim() || uuidv4()),
      ownerId: userId,
      createdAt: now,
      updatedAt: now,
    };

    const invalid = validateCustomStepDefinition(candidate);
    if (invalid) return res.status(400).json({ error: invalid });

    await db.saveCustomStepDefinition(candidate);
    res.status(201).json(candidate);
  }));

  router.put('/:id', asyncRoute(async (req, res) => {
    const userId = userOf(req).id;
    const existing = (await db.getCustomStepDefinitions(userId)).find((d) => d.id === req.params.id);
    const candidate: CustomStepDefinition = {
      ...(req.body ?? {}),
      id: String(req.params.id ?? ''),
      ownerId: userId,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const invalid = validateCustomStepDefinition(candidate);
    if (invalid) return res.status(400).json({ error: invalid });

    await db.saveCustomStepDefinition(candidate);
    res.json(candidate);
  }));

  router.delete('/:id', asyncRoute(async (req, res) => {
    const userId = userOf(req).id;
    const id = String(req.params.id ?? '');

    const inUse = (await db.getTreeTypes(userId)).filter((t) =>
      t.validationRecipe && someRecipeLeaf(t.validationRecipe.checks, (c) => c.customStepId === id));
    if (inUse.length) {
      return res.status(409).json({
        error: `${inUse.length} tree type(s) still use this custom step: ${inUse.map((t) => t.label).join(', ')}.`,
      });
    }

    await db.deleteCustomStepDefinition(id, userId);
    res.json({ deleted: id });
  }));

  return router;
}
