import { Router, type Request, type Response } from 'express';
import { asyncRoute } from '../../platform/index.js';
import type { ReleaseSettings } from '../services/ReleaseSettings.js';

const userOf = (req: Request): { id: string } => (req as unknown as { user: { id: string } }).user;
const param = (req: Request, name: string): string => String(req.params[name] ?? '');
const howOf = (req: Request): unknown => (req.body?.release === null ? undefined : req.body?.release);

export function releaseSettingsRouter(deps: { settings: Pick<ReleaseSettings, 'options' | 'setForType' | 'ofProject' | 'setForProject'> }): Router {
  const router = Router();

  router.get('/options', asyncRoute(async (req: Request, res: Response) => {
    res.json(await deps.settings.options(userOf(req).id));
  }));

  router.put('/tree-types/:id', asyncRoute(async (req: Request, res: Response) => {
    const outcome = await deps.settings.setForType(userOf(req).id, param(req, 'id'), howOf(req));
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    res.json(outcome.value);
  }));

  router.get('/projects/:id', asyncRoute(async (req: Request, res: Response) => {
    const outcome = await deps.settings.ofProject(userOf(req).id, param(req, 'id'));
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    res.json(outcome.value);
  }));

  router.put('/projects/:id', asyncRoute(async (req: Request, res: Response) => {
    const outcome = await deps.settings.setForProject(userOf(req).id, param(req, 'id'), howOf(req));
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    res.json(outcome.value);
  }));

  return router;
}
