import { Router, type Request, type Response } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import { summariseLevel1, type Level1Service } from '../services/Level1Service.js';
import { replyTokensProblem, samplingAt, temperatureProblem } from '../lib/run-knobs.js';

export interface Level1RouterDeps {
  level1: Level1Service;
}

const userOf = (req: Request): { id: string } =>
  (req as unknown as { user: { id: string } }).user;

export function evalsLevel1Router(deps: Level1RouterDeps): Router {
  const router = Router();

  router.get('/cases', asyncRoute(async (req: Request, res: Response) => {
    const ownerId = userOf(req).id;
    const [cases, coverage] = await Promise.all([deps.level1.cases(ownerId), deps.level1.coverage(ownerId)]);
    res.json({ cases, coverage });
  }));

  router.put('/cases/:group/:name', asyncRoute(async (req: Request, res: Response) => {
    const name = `${String(req.params.group)}/${String(req.params.name)}`;
    if (req.body?.name !== name) return res.status(400).json({ error: `the case in the body is not called "${name}"` });
    const outcome = await deps.level1.saveCase(userOf(req).id, req.body);
    if (!outcome.saved) return res.status(400).json({ error: 'The case has problems', problems: outcome.problems });
    return res.json({ case: outcome.case });
  }));

  router.delete('/cases/:group/:name', asyncRoute(async (req: Request, res: Response) => {
    const removed = await deps.level1.deleteCase(userOf(req).id, `${String(req.params.group)}/${String(req.params.name)}`);
    if (!removed) return res.status(404).json({ error: 'You have no case called that to delete' });
    return res.json({ ok: true });
  }));

  router.get('/runs', asyncRoute(async (req: Request, res: Response) => {
    const runs = await deps.level1.list(userOf(req).id);
    res.json({ runs: runs.map((run) => ({ ...run, summary: summariseLevel1(run) })) });
  }));

  router.post('/runs', asyncRoute(async (req: Request, res: Response) => {
    const { repeats, only, modelId, modelLabel, temperature, maxTokens } = (req.body ?? {}) as {
      repeats?: number; only?: string[]; modelId?: string; modelLabel?: string; temperature?: number; maxTokens?: number;
    };
    if (repeats !== undefined && (!Number.isInteger(repeats) || repeats < 1 || repeats > 25)) {
      return res.status(400).json({ error: 'repeats has to be a whole number between 1 and 25' });
    }
    if (only !== undefined && (!Array.isArray(only) || only.some((name) => typeof name !== 'string'))) {
      return res.status(400).json({ error: 'only has to be a list of case names' });
    }
    const knobProblem = temperatureProblem(temperature) ?? replyTokensProblem(maxTokens);
    if (knobProblem) return res.status(400).json({ error: knobProblem });

    const started = await deps.level1.start({
      ownerId: userOf(req).id,
      ...(repeats === undefined ? {} : { repeats }),
      ...(only === undefined ? {} : { only }),
      ...(modelId === undefined ? {} : { modelId }),
      ...(modelLabel === undefined ? {} : { modelLabel }),
      ...(temperature === undefined ? {} : { sampling: samplingAt(temperature) }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
    });
    if ('unknown' in started) return res.status(400).json({ error: `there is no case called ${started.unknown.map((name) => `"${name}"`).join(', ')}` });
    return res.status(202).json({ ...started, summary: summariseLevel1(started) });
  }));

  router.get('/runs/:id', asyncRoute(async (req: Request, res: Response) => {
    const run = await deps.level1.get(userOf(req).id, String(req.params.id));
    if (!run) return res.status(404).json({ error: 'There is no eval run with that id' });
    return res.json({ ...run, summary: summariseLevel1(run) });
  }));

  router.post('/runs/:id/cancel', asyncRoute(async (req: Request, res: Response) => {
    if (!deps.level1.cancel(userOf(req).id, String(req.params.id))) return res.status(409).json({ error: 'That run is not running' });
    return res.status(202).json({ cancelling: true });
  }));

  router.get('/prompts/:hash', asyncRoute(async (req: Request, res: Response) => {
    const text = await deps.level1.prompt(userOf(req).id, String(req.params.hash));
    if (text === undefined) return res.status(404).json({ error: 'There is no saved prompt with that hash' });
    return res.json({ hash: req.params.hash, text });
  }));

  router.get('/compare', asyncRoute(async (req: Request, res: Response) => {
    const before = String(req.query.before ?? '');
    const after = String(req.query.after ?? '');
    const comparison = await deps.level1.compare(userOf(req).id, before, after);
    if (!comparison) return res.status(404).json({ error: 'Both runs have to exist and be yours' });
    return res.json(comparison);
  }));

  return router;
}
