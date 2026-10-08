import { Router, type Request, type Response } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import type { Level2Service } from '../services/Level2Service.js';
import type { BenchService } from '../services/BenchService.js';
import type { PracticeService } from '../services/PracticeService.js';
import type { AgentChangeService } from '../services/AgentChangeService.js';
import { samplingAt, temperatureProblem } from '../lib/run-knobs.js';

export interface Level2RouterDeps {
  level2: Level2Service;
  bench?: BenchService | undefined;
  practices?: PracticeService | undefined;
  changes?: AgentChangeService | undefined;
}

const userOf = (req: Request): { id: string } =>
  (req as unknown as { user: { id: string } }).user;

export function evalsLevel2Router(deps: Level2RouterDeps): Router {
  const router = Router();

  router.get('/bench', asyncRoute(async (req: Request, res: Response) => {
    if (!deps.bench) return res.status(404).json({ error: 'there is no bench here' });
    const ownerId = userOf(req).id;
    res.json({ settings: await deps.bench.settings(ownerId), state: await deps.bench.state(ownerId) });
  }));

  router.put('/bench', asyncRoute(async (req: Request, res: Response) => {
    if (!deps.bench) return res.status(404).json({ error: 'there is no bench here' });
    const outcome = await deps.bench.saveSettings(userOf(req).id, req.body);
    if (!outcome.saved) return res.status(400).json({ problems: outcome.problems });
    res.json({ settings: outcome.settings });
  }));

  router.get('/changes', asyncRoute(async (req: Request, res: Response) => {
    res.json({ changes: deps.changes ? await deps.changes.list(userOf(req).id) : [] });
  }));

  router.post('/changes/:id/accept', asyncRoute(async (req: Request, res: Response) => {
    if (!deps.changes) return res.status(404).json({ error: 'there are no changes here' });
    const outcome = await deps.changes.accept(userOf(req).id, String(req.params.id), req.body?.prompt);
    if (!outcome.accepted) return res.status(outcome.status).json({ problems: outcome.problems });
    res.json({ change: outcome.change });
  }));

  router.post('/changes/:id/hand-over', asyncRoute(async (req: Request, res: Response) => {
    if (!deps.changes) return res.status(404).json({ error: 'there are no changes here' });
    const outcome = await deps.changes.handOver(userOf(req).id, String(req.params.id));
    if (!outcome.accepted) return res.status(outcome.status).json({ problems: outcome.problems });
    res.json({ change: outcome.change });
  }));

  router.post('/changes/:id/dismiss', asyncRoute(async (req: Request, res: Response) => {
    if (!(await deps.changes?.dismiss(userOf(req).id, String(req.params.id)))) return res.status(404).json({ error: 'there is no change waiting with that id' });
    res.json({ dismissed: true });
  }));

  router.get('/practices', asyncRoute(async (req: Request, res: Response) => {
    res.json({ practices: deps.practices ? await deps.practices.list(userOf(req).id) : [] });
  }));

  router.post('/practices/:id/live', asyncRoute(async (req: Request, res: Response) => {
    const live = await deps.practices?.makeLive(userOf(req).id, String(req.params.id));
    if (!live) return res.status(404).json({ error: 'there is no practice waiting with that id' });
    res.json({ practice: live });
  }));

  router.post('/practices/:id/retire', asyncRoute(async (req: Request, res: Response) => {
    if (!(await deps.practices?.retire(userOf(req).id, String(req.params.id)))) return res.status(404).json({ error: 'there is no practice with that id' });
    res.json({ retired: true });
  }));

  router.get('/proposals', asyncRoute(async (req: Request, res: Response) => {
    res.json({ proposals: await deps.level2.proposals(userOf(req).id) });
  }));

  router.post('/proposals/:id/accept', asyncRoute(async (req: Request, res: Response) => {
    const outcome = await deps.level2.acceptProposal(userOf(req).id, String(req.params.id), req.body?.scenario);
    if ('missing' in outcome) return res.status(404).json({ error: 'there is no proposal waiting with that id' });
    if (!outcome.saved) return res.status(400).json({ problems: outcome.problems });
    res.json({ scenario: outcome.scenario });
  }));

  router.post('/proposals/:id/dismiss', asyncRoute(async (req: Request, res: Response) => {
    if (!(await deps.level2.dismissProposal(userOf(req).id, String(req.params.id)))) return res.status(404).json({ error: 'there is no proposal waiting with that id' });
    res.json({ dismissed: true });
  }));

  router.get('/coverage', asyncRoute(async (req: Request, res: Response) => {
    res.json({ gaps: await deps.level2.coverage(userOf(req).id) });
  }));

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

  router.get('/scenarios/:id/procedure', asyncRoute(async (req: Request, res: Response) => {
    const procedure = await deps.level2.checkProcedure(userOf(req).id, String(req.params.id));
    if (!procedure) return res.status(404).json({ error: 'That check runs a procedure of the store, not one made for it' });
    return res.json({ procedure });
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

  router.get('/compare', asyncRoute(async (req: Request, res: Response) => {
    const { before, after } = req.query;
    if (typeof before !== 'string' || typeof after !== 'string') return res.status(400).json({ error: 'name the two runs to compare, as before and after' });
    const comparison = await deps.level2.compare(userOf(req).id, before, after);
    if (!comparison) return res.status(404).json({ error: 'You have no check run with one of those ids' });
    return res.json(comparison);
  }));

  router.get('/runs/:id', asyncRoute(async (req: Request, res: Response) => {
    const run = await deps.level2.get(userOf(req).id, String(req.params.id));
    if (!run) return res.status(404).json({ error: 'There is no scenario run with that id' });
    return res.json(run);
  }));

  router.post('/runs/:id/cancel', asyncRoute(async (req: Request, res: Response) => {
    if (!(await deps.level2.cancel(userOf(req).id, String(req.params.id)))) return res.status(409).json({ error: 'That run is not running' });
    return res.status(202).json({ cancelling: true });
  }));

  return router;
}
