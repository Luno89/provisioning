import { Router } from 'express';

export function stepsRouter(): Router {
  const router = Router({ mergeParams: true });
  router.post('/login', (_req, res) => { res.json({}); });
  return router;
}

export function sessionsRouter(deps: { steps: Router }): Router {
  const router = Router();
  router.use('/:sid', deps.steps);
  return router;
}
