import { Router, type Request, type Response } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import type { RunningOutcome, RunningService } from '../services/RunningService.js';

export interface RunningRouterDeps {
  running: Pick<RunningService, 'view' | 'cancel' | 'pauseBench' | 'pauseKeeper'>;
}

const userOf = (req: Request): { id: string } => (req as unknown as { user: { id: string } }).user;

const answer = <T>(res: Response, outcome: RunningOutcome<T>, status = 200) =>
  (outcome.ok ? res.status(status).json(outcome.value) : res.status(outcome.status).json({ error: outcome.error }));

export function runningRouter(deps: RunningRouterDeps): Router {
  const router = Router();

  router.get('/', asyncRoute(async (req, res) => answer(res, await deps.running.view(userOf(req).id))));

  router.post('/:workflowId/cancel', asyncRoute(async (req, res) => answer(res, await deps.running.cancel(userOf(req).id, String(req.params.workflowId)), 202)));

  router.put('/bench', asyncRoute(async (req, res) => answer(res, await deps.running.pauseBench(userOf(req).id, req.body))));

  router.put('/keeper', asyncRoute(async (req, res) => answer(res, await deps.running.pauseKeeper(userOf(req).id, req.body))));

  return router;
}
