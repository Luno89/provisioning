import { Router, type Request, type Response } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import type { AccountRemovalService } from '../services/AccountRemovalService.js';

const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

export interface AccountRouterDeps {
  removal: Pick<AccountRemovalService, 'preview' | 'remove'>;
  clearSession: (res: Response) => void;
}

export function accountRouter(deps: AccountRouterDeps): Router {
  const router = Router();

  router.get('/removal', asyncRoute(async (req: Request, res: Response) => {
    const preview = await deps.removal.preview(userOf(req).id);
    if (!preview) return res.status(404).json({ error: 'There is no such account' });
    return res.json(preview);
  }));

  router.delete('/', asyncRoute(async (req: Request, res: Response) => {
    const confirm = typeof req.body?.confirm === 'string' ? req.body.confirm : '';
    const outcome = await deps.removal.remove({ ownerId: userOf(req).id, requestedBy: userOf(req).id, confirm });
    if (!outcome.ok) return res.status(outcome.refusal.status).json(outcome.refusal);
    deps.clearSession(res);
    return res.status(202).json({ state: outcome.state });
  }));

  return router;
}
