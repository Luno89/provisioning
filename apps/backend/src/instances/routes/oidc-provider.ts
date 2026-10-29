import { Router, type Request, type Response } from 'express';
import { asyncRoute } from '../../platform/index.js';
import type { RootProvider } from '../services/RootProvider.js';

export function oidcProviderRouter(deps: {
  provider: Pick<RootProvider, 'provider' | 'continueInteraction'>;
  signedIn: (req: Request) => Promise<{ id: string } | undefined>;
}): Router {
  const router = Router();

  router.get('/interaction/:uid', asyncRoute(async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const waiting = await deps.provider.continueInteraction(req, res, (await deps.signedIn(req))?.id);
    if (waiting) res.redirect(302, `/?resume=${encodeURIComponent(waiting.resume)}`);
  }));

  router.use(deps.provider.provider.callback());
  return router;
}
