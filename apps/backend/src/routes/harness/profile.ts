import { Router, type Request } from 'express';
import { asyncRoute } from '../../middleware/async-route.js';
import { ownedBy, withBuiltIns } from '../../lib/ownership.js';
import type { Database } from '../../lib/db-interface.js';
import { buildPromotion, supersede, revertTo, withPack } from '../../lib/harness-profile.js';
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
  const now = () => new Date().toISOString();

  /** Both the user's own packs and their experiments' arms — promotion has to see both. */
  const visiblePacksAndArms = async (userId: string) =>
    withBuiltIns(await db.getPersonaPacks(), userId, (p) => p.slug);

  router.get('/', async (req, res) => {
    res.json(await db.getHarnessProfile(userOf(req).id));
  });

  router.put('/', async (req, res) => {
    const userId = userOf(req).id;
    const { packId } = req.body ?? {};
    if (packId !== undefined && typeof packId !== 'string') {
      return res.status(400).json({ error: 'packId must be a string' });
    }

    const visible = await visiblePacksAndArms(userId);
    if (packId && !visible.some((p) => p.id === packId || p.slug === packId)) {
      return res.status(400).json({ error: `No pack ${packId}` });
    }

    const current = await db.getHarnessProfile(userId);
    const saved = supersede(current, withPack(current, packId, userId));
    await db.saveHarnessProfile(saved);
    res.json(saved);
  });

  router.post('/promote', async (req, res) => {
    const userId = userOf(req).id;
    const ownerId = userId;
    const { experimentId, label } = req.body ?? {};

    const experiment = (await db.getExperiments())
      .find((e) => e.id === experimentId && e.ownerId === userId);
    if (!experiment) return res.status(404).json({ error: 'No such experiment' });

    const built = buildPromotion(
      experiment, String(label ?? ''), await visiblePacksAndArms(userId),
    );
    if (!built) return res.status(400).json({ error: 'That variant has no results to promote.' });

    /**
     * Promotion OVERWRITES the pack the arm was derived from — the user asked for that rather than
     * accumulating ten near-identical packs — so it does not happen without saying so. The UI shows
     * `changes` from /preview first; this refuses until that has been confirmed.
     */
    if (req.body?.confirm !== true) {
      return res.status(409).json({
        error: `Promoting "${label}" overwrites the pack "${built.target.name}".`,
        target: { id: built.target.id, name: built.target.name },
        changes: built.changes,
        confirmRequired: true,
      });
    }

    await db.savePersonaPack(built.pack);
    const current = await db.getHarnessProfile(userId);
    await db.saveHarnessProfile(supersede(current, {
      ...(current ?? { ownerId, updatedAt: now() }),
      ownerId,
      packId: built.pack.id,
      from: {
        experimentId: experiment.id,
        experimentName: experiment.name,
        variantLabel: String(label ?? ''),
        verified: built.standing.verified,
        runs: built.standing.runs,
        tasks: built.standing.tasks,
        wasBest: built.standing.wasBest,
        promotedAt: now(),
      },
      updatedAt: now(),
    }));
    res.json(built);
  });

  router.get('/preview', async (req, res) => {
    const userId = userOf(req).id;
    const experiment = (await db.getExperiments())
      .find((e) => e.id === req.query.experimentId && e.ownerId === userId);
    if (!experiment) return res.status(404).json({ error: 'No such experiment' });

    const built = buildPromotion(
      experiment, String(req.query.label ?? ''), await visiblePacksAndArms(userId),
    );
    if (!built) return res.status(400).json({ error: 'That variant has no results to promote.' });
    res.json({
      standing: built.standing,
      changes: built.changes,
      target: { id: built.target.id, name: built.target.name },
    });
  });

  router.delete('/', async (req, res) => {
    const userId = userOf(req).id;
    const current = await db.getHarnessProfile(userId);
    if (!current) return res.json({ reset: true });

    await db.saveHarnessProfile(supersede(current, { ownerId: userId, updatedAt: '' }));
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
