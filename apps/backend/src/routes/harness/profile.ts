import { Router, type Request } from 'express';
import { asyncRoute } from '../../middleware/async-route.js';
import { ownedBy } from '../../lib/ownership.js';
import type { Database } from '../../lib/db-interface.js';
import { resolveConfig } from '../../lib/personas.js';
import { validateOverrides } from '../../lib/tunables.js';
import { buildPromotion, supersede, revertTo, withOverrides } from '../../lib/harness-profile.js';
import { latestResults } from '../../lib/experiments.js';

/** The `:id` from the path, narrowed once — Express types `req.params` loosely inside asyncRoute. */
const idOf = (req: Request): string => String(req.params.id ?? '');

/** The user `requireAuth` put on the request. */
const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

/**
 * The promoted defaults — a winning configuration adopted as the baseline. See lib/harness-profile.ts.
 *
 * Extracted from index.ts, where `/api/harness/*` was 34 routes on one `app` object.
 */
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

  /** Directly updates adopted profile overrides. */
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
    // Carry-forward lives in harness-profile.ts, not here — see `withOverrides` for what writing it
    // out by hand cost.
    const updatedProfile = withOverrides(current, overrides, userId);
    const saved = supersede(current, updatedProfile);
    await db.saveHarnessProfile(saved);
    // The SAVED record, not the pre-supersede one: they differ by `history` and `updatedAt`, and
    // answering with the input means the client renders a profile that was never stored.
    res.json(saved);
  });

  /**
   * Adopts a variant's configuration as the default.
   *
   * Deliberately does NOT refuse a variant that lost. A variant that ties on verification while
   * costing half the tokens is worth adopting, and so is one that loses on a suite you have judged
   * unrepresentative — refusing would push the same decision into a hand-edited config where no
   * evidence is recorded at all. What it does instead is compute the standing server-side and
   * store it, so a default can always explain what it beat and by how much.
   */
  router.post('/promote', async (req, res) => {
    const userId = userOf(req).id;
    const { experimentId, label } = req.body ?? {};

    const experiment = (await db.getExperiments())
      .find((e) => e.id === experimentId && e.ownerId === userId);
    if (!experiment) return res.status(404).json({ error: 'No such experiment' });

    const current = await db.getHarnessProfile(userId);
    const built = buildPromotion(experiment, String(label ?? ''), current, userId);
    if (!built) return res.status(400).json({ error: 'That variant has no results to promote.' });

    /**
     * Promotion writes a PROFILE, so it is held to the profile's rules.
     *
     * A variant that won partly because of its model must not carry that model into a profile —
     * that is precisely the one-field repointing of every persona that `settableAt` exists to stop.
     * Refused rather than silently stripped: a promoted profile that quietly differs from the
     * variant that won is worse than an error explaining why.
     */
    const models = await modelIdsFor(userId);
    const invalid = validateOverrides(built.profile.overrides, { layer: 'profile', ...(models ? { models } : {}) });
    if (invalid) return res.status(400).json({ error: invalid });

    // Filed rather than overwritten: adopting a default has to be undoable, and a diff needs
    // something to diff against.
    await db.saveHarnessProfile(supersede(current, built.profile));
    res.json(built);
  });

  /** Previews a promotion without applying it, so the diff can be shown before the button. */
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

  /** Back to the harness's built-in settings — but the configuration dropped is kept. */
  router.delete('/', async (req, res) => {
    const userId = userOf(req).id;
    const current = await db.getHarnessProfile(userId);
    if (!current) return res.json({ reset: true });

    // Not a delete. Resetting is a change like any other, and a reset you cannot undo is how an
    // afternoon of tuning disappears on one click.
    await db.saveHarnessProfile(supersede(current, { ownerId: userId, overrides: {}, updatedAt: '' }));
    res.json({ reset: true });
  });

  /** Restores a superseded configuration, filing the current one on the way. */
  router.post('/revert', async (req, res) => {
    const userId = userOf(req).id;
    const current = await db.getHarnessProfile(userId);
    if (!current) return res.status(404).json({ error: 'Nothing has been adopted yet.' });

    const reverted = revertTo(current, String(req.body?.versionId ?? ''));
    if (!reverted) return res.status(404).json({ error: 'No such version.' });

    await db.saveHarnessProfile(reverted);
    res.json(reverted);
  });

  /**
   * The list: scores only.
   *
   * Full records carry a trace per run — up to 24 steps of several kilobytes each — plus every
   * task's prompt and every run's verify output. Returning those here meant the client re-fetched
   * the entire archive every five seconds, which was survivable only while probe experiments
   * deleted themselves. Once history persists it grows without bound, so evidence moved to the
   * detail route and this carries what the matrix renders.
   */
  return router;
}
