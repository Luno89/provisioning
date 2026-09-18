import { Router, type Request, type Response } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import type { Level2Service } from '../services/Level2Service.js';
import { samplingAt, temperatureProblem } from '../lib/run-knobs.js';

export interface Level2RouterDeps {
  level2: Level2Service;
}

const userOf = (req: Request): { id: string } =>
  (req as unknown as { user: { id: string } }).user;

export function evalsLevel2Router(deps: Level2RouterDeps): Router {
  const router = Router();

  router.get('/scenarios', asyncRoute(async (req: Request, res: Response) => {
    res.json({ scenarios: await deps.level2.scenarios(userOf(req).id) });
  }));

  router.put('/scenarios/:id', asyncRoute(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (req.body?.id !== id) return res.status(400).json({ error: `the scenario in the body is not called "${id}"` });
    const outcome = await deps.level2.saveScenario(userOf(req).id, req.body);
    if (!outcome.saved) return res.status(400).json({ error: 'The scenario has problems', problems: outcome.problems });
    return res.json({ scenario: outcome.scenario });
  }));

  router.delete('/scenarios/:id', asyncRoute(async (req: Request, res: Response) => {
    const removed = await deps.level2.deleteScenario(userOf(req).id, String(req.params.id));
    if (!removed) return res.status(404).json({ error: 'You have no scenario of your own with that id' });
    return res.json({ ok: true });
  }));

  router.get('/runs', asyncRoute(async (req: Request, res: Response) => {
    res.json({ runs: await deps.level2.list(userOf(req).id) });
  }));

  router.post('/runs', asyncRoute(async (req: Request, res: Response) => {
    const { only, modelId, modelLabel, temperature } = (req.body ?? {}) as {
      only?: string[]; modelId?: string; modelLabel?: string; temperature?: number;
    };
    if (only !== undefined && (!Array.isArray(only) || only.some((id) => typeof id !== 'string'))) {
      return res.status(400).json({ error: 'only has to be a list of scenario ids' });
    }
    const knobProblem = temperatureProblem(temperature);
    if (knobProblem) return res.status(400).json({ error: knobProblem });

    const started = await deps.level2.start({
      ownerId: userOf(req).id,
      ...(only === undefined ? {} : { only }),
      ...(modelId === undefined ? {} : { modelId }),
      ...(modelLabel === undefined ? {} : { modelLabel }),
      ...(temperature === undefined ? {} : { sampling: samplingAt(temperature) }),
    });
    if ('unknown' in started) return res.status(400).json({ error: `there is no scenario called ${started.unknown.map((id) => `"${id}"`).join(', ')}` });
    return res.status(202).json(started);
  }));

  router.get('/runs/:id', asyncRoute(async (req: Request, res: Response) => {
    const run = await deps.level2.get(userOf(req).id, String(req.params.id));
    if (!run) return res.status(404).json({ error: 'There is no scenario run with that id' });
    return res.json(run);
  }));

  router.post('/runs/:id/cancel', asyncRoute(async (req: Request, res: Response) => {
    if (!deps.level2.cancel(userOf(req).id, String(req.params.id))) return res.status(409).json({ error: 'That run is not running' });
    return res.status(202).json({ cancelling: true });
  }));

  return router;
}
