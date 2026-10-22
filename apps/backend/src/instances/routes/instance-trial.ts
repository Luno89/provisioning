import { Router, type Request, type Response } from 'express';
import { asyncRoute } from '../../platform/middleware/async-route.js';
import { RootRefused, type InstanceTrial } from '../services/InstanceTrial.js';

type Trial = Pick<InstanceTrial, 'read' | 'startMove' | 'moveState' | 'stopMove'>;

const refused = (res: Response, err: unknown) =>
  res.status(err instanceof RootRefused ? err.status : 502).json({ error: (err as Error).message });

export function instanceTrialRouter(deps: { trial: Trial | undefined }): Router {
  const router = Router();

  router.get('/', asyncRoute(async (_req: Request, res: Response) => {
    res.json(deps.trial ? await deps.trial.read() : {});
  }));

  router.get('/move', asyncRoute(async (_req: Request, res: Response) => {
    if (!deps.trial) return res.json({ move: null });
    return deps.trial.moveState().then((move) => res.json({ move }), (err) => refused(res, err));
  }));

  router.post('/move', asyncRoute(async (_req: Request, res: Response) => {
    if (!deps.trial) return res.status(404).json({ error: 'only an instance on Koala\'s servers moves' });
    return deps.trial.startMove().then((started) => res.json(started), (err) => refused(res, err));
  }));

  router.delete('/move', asyncRoute(async (_req: Request, res: Response) => {
    if (!deps.trial) return res.status(404).json({ error: 'nothing is moving' });
    return deps.trial.stopMove().then(() => res.json({ stopping: true }), (err) => refused(res, err));
  }));

  return router;
}
