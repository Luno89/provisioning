import { Router, type Request } from 'express';
import { asyncRoute } from '../../middleware/async-route.js';
import { ownedBy } from '../../lib/ownership.js';
import type { Database } from '../../lib/db-interface.js';
import { resolveConfig } from '../../lib/personas.js';
import { validateOverrides } from '../../lib/tunables.js';
import { buildPromotion, supersede, revertTo, withOverrides } from '../../lib/harness-profile.js';
import { latestResults } from '../../lib/experiments.js';

const idOf = (req: Request): string => String(req.params.id ?? '');

const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

export interface profileRouterDeps {
  db: Database;
  modelIdsFor: (u: string) => Promise<string[] | undefined>;
}

export function profileRouter(deps: profileRouterDeps): Router {
  const { db, modelIdsFor } = deps;
  const router = Router();

  router.get('/', async (req, res) => {
    res.json(await db.getHarnessProfile(userOf(req).id));
  });

  router.put('/', async (req, res) => {
    const userId = userOf(req).id;
    const { overrides } = req.body ?? {};
    if (typeof overrides !== 'object' || overrides === null) {
      return res.status(400).json({ error: 'overrides must be an object' });
    }
    const models = await modelIdsFor(userId);
    const invalid = validateOverrides(overrides, { layer: 'profile', ...(models ? { models } : {}) });
    if (invalid) return res.status(400).json({ error: invalid });

    const current = await db.getHarnessProfile(userId);
    const updatedProfile = withOverrides(current, overrides, userId);
    const saved = supersede(current, updatedProfile);
    await db.saveHarnessProfile(saved);
    res.json(saved);
  });

  router.post('/promote', async (req, res) => {
    const userId = userOf(req).id;
    const { experimentId, label } = req.body ?? {};

    const experiment = (await db.getExperiments())
      .find((e) => e.id === experimentId && e.ownerId === userId);
    if (!experiment) return res.status(404).json({ error: 'No such experiment' });

    const current = await db.getHarnessProfile(userId);
    const built = buildPromotion(experiment, String(label ?? ''), current, userId);
    if (!built) return res.status(400).json({ error: 'That variant has no results to promote.' });

    const models = await modelIdsFor(userId);
    const invalid = validateOverrides(built.profile.overrides, { layer: 'profile', ...(models ? { models } : {}) });
    if (invalid) return res.status(400).json({ error: invalid });

    await db.saveHarnessProfile(supersede(current, built.profile));
    res.json(built);
  });

  router.get('/preview', async (req, res) => {
    const userId = userOf(req).id;
    const experiment = (await db.getExperiments())
      .find((e) => e.id === req.query.experimentId && e.ownerId === userId);
    if (!experiment) return res.status(404).json({ error: 'No such experiment' });

    const built = buildPromotion(
      experiment,
      String(req.query.label ?? ''),
      await db.getHarnessProfile(userId),
      userId,
    );
    if (!built) return res.status(400).json({ error: 'That variant has no results to promote.' });
    res.json({ standing: built.standing, changes: built.changes });
  });

  router.delete('/', async (req, res) => {
    const userId = userOf(req).id;
    const current = await db.getHarnessProfile(userId);
    if (!current) return res.json({ reset: true });

    await db.saveHarnessProfile(supersede(current, { ownerId: userId, overrides: {}, updatedAt: '' }));
    res.json({ reset: true });
  });

  router.post('/revert', async (req, res) => {
    const userId = userOf(req).id;
    const current = await db.getHarnessProfile(userId);
    if (!current) return res.status(404).json({ error: 'Nothing has been adopted yet.' });

    const reverted = revertTo(current, String(req.body?.versionId ?? ''));
    if (!reverted) return res.status(404).json({ error: 'No such version.' });

    await db.saveHarnessProfile(reverted);
    res.json(reverted);
  });

  return router;
}
