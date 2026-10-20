import { Router, type Request, type Response } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import type { InstanceTrial } from '../services/InstanceTrial.js';

export function instanceTrialRouter(deps: { trial: Pick<InstanceTrial, 'read'> | undefined }): Router {
  const router = Router();

  router.get('/', asyncRoute(async (_req: Request, res: Response) => {
    res.json(deps.trial ? await deps.trial.read() : {});
  }));

  return router;
}
