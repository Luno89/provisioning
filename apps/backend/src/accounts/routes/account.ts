import { Router, type Request, type Response } from 'express';
import { asyncRoute, principalFrom, removalProgressOf, removalProgressToken, type OpenRoute, type SecretKey } from '../../platform/index.js';
import type { AccountRemovalService } from '../services/AccountRemovalService.js';
import type { Refusal } from '../services/AuthService.js';

const userOf = (req: Request): { id: string; email: string } =>
  (req as unknown as { user: { id: string; email: string } }).user;

export interface AccountRouterDeps {
  removal: Pick<AccountRemovalService, 'preview' | 'remove' | 'removalProgress'>;
  clearSession: (res: Response) => void;
  confirmed: (req: Request) => Promise<Refusal | undefined>;
  progressKey: SecretKey;
}

export const ACCOUNT_OPEN: readonly OpenRoute[] = ['/removal/progress'];

export function accountRouter(deps: AccountRouterDeps): Router {
  const router = Router();

  router.get('/removal/progress', asyncRoute(async (req: Request, res: Response) => {
    const presented = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
    const ownerId = presented ? removalProgressOf(presented, deps.progressKey) : undefined;
    if (!ownerId) return res.status(401).json({ error: 'This does not show a removal' });
    const progress = await deps.removal.removalProgress(ownerId);
    if (!progress) return res.status(404).json({ error: 'This account is not being removed' });
    return res.json(progress);
  }));

  router.get('/removal', asyncRoute(async (req: Request, res: Response) => {
    const preview = await deps.removal.preview(userOf(req).id);
    if (!preview) return res.status(404).json({ error: 'There is no such account' });
    return res.json(preview);
  }));

  router.delete('/', asyncRoute(async (req: Request, res: Response) => {
    const { confirm: given } = (req.body ?? {}) as { confirm?: unknown };
    const confirm = typeof given === 'string' ? given : '';
    const outcome = await deps.removal.remove({ ownerId: userOf(req).id, requestedBy: userOf(req).id, confirm }, principalFrom(req), () => deps.confirmed(req));
    if (!outcome.ok) return res.status(outcome.refusal.status).json(outcome.refusal);
    deps.clearSession(res);
    return res.status(202).json({ state: outcome.state, progress: removalProgressToken(userOf(req).id, deps.progressKey) });
  }));

  return router;
}
