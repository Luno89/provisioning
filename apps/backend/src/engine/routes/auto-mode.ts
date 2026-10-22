import { Router, type Request, type Response } from 'express';
import { asyncRoute } from '../../platform/index.js';
import type { AutoModeService } from '../services/AutoModeService.js';

export interface AutoModeRouterDeps {
  autoMode: Pick<AutoModeService, 'agents' | 'setAgent' | 'setTree' | 'setConversation'>;
}

const userOf = (req: Request): { id: string } =>
  (req as unknown as { user: { id: string } }).user;

export function autoModeRouter(deps: AutoModeRouterDeps): Router {
  const router = Router();

  router.get('/', asyncRoute(async (req: Request, res: Response) => {
    res.json({ agents: await deps.autoMode.agents(userOf(req).id) });
  }));

  router.put('/agents/:slug', asyncRoute(async (req: Request, res: Response) => {
    const outcome = await deps.autoMode.setAgent(userOf(req).id, String(req.params.slug), req.body);
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    return res.json(outcome.value);
  }));

  router.put('/trees/:id', asyncRoute(async (req: Request, res: Response) => {
    const outcome = await deps.autoMode.setTree(userOf(req).id, String(req.params.id), req.body);
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    return res.json(outcome.value);
  }));

  router.put('/conversations/:id', asyncRoute(async (req: Request, res: Response) => {
    const outcome = await deps.autoMode.setConversation(userOf(req).id, String(req.params.id), req.body);
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    return res.json(outcome.value);
  }));

  return router;
}
