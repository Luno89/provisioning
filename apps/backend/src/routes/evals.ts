import { Router, type Request, type Response } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import type { EvalService } from '../services/EvalService.js';

export interface EvalRouterDeps {
  evals: EvalService;
}

const userOf = (req: Request): { id: string } =>
  (req as unknown as { user: { id: string } }).user;

export function evalsRouter(deps: EvalRouterDeps): Router {
  const router = Router();

  router.get('/cases', asyncRoute(async (_req: Request, res: Response) => {
    res.json({
      cases: deps.evals.cases().map((entry) => ({
        name: entry.name,
        category: entry.category,
        agent: entry.agent,
        say: entry.say,
        expects: entry.expect.tool,
      })),
      coverage: deps.evals.coverage(),
    });
  }));

  router.get('/runs', asyncRoute(async (req: Request, res: Response) => {
    res.json({ runs: deps.evals.list(userOf(req).id) });
  }));

  router.post('/runs', asyncRoute(async (req: Request, res: Response) => {
    const { repeats, only, modelId, modelLabel } = req.body as {
      repeats?: number; only?: string[]; modelId?: string; modelLabel?: string;
    };

    if (repeats !== undefined && (!Number.isInteger(repeats) || repeats < 1 || repeats > 25)) {
      return res.status(400).json({ error: 'repeats has to be a whole number between 1 and 25' });
    }

    const run = deps.evals.start({
      ownerId: userOf(req).id,
      ...(repeats === undefined ? {} : { repeats }),
      ...(only === undefined ? {} : { only }),
      ...(modelId === undefined ? {} : { modelId }),
      ...(modelLabel === undefined ? {} : { modelLabel }),
    });

    return res.status(202).json(run);
  }));

  router.get('/runs/:id', asyncRoute(async (req: Request, res: Response) => {
    const run = deps.evals.get(userOf(req).id, String(req.params.id ?? ''));
    if (!run) return res.status(404).json({ error: 'There is no eval run with that id' });

    return res.json(run);
  }));

  router.post('/runs/:id/cancel', asyncRoute(async (req: Request, res: Response) => {
    const stopped = deps.evals.cancel(userOf(req).id, String(req.params.id ?? ''));
    if (!stopped) return res.status(409).json({ error: 'That run is not running' });

    return res.status(202).json({ cancelling: true });
  }));

  return router;
}
