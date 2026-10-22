import { Router, type Request } from 'express';
import { asyncRoute } from '../../platform/index.js';
import type { Viewer } from '../../monitoring/services/MonitoringService.js';
import { idsToClear, type InfrastructureViewService } from '../services/InfrastructureViewService.js';

export interface InfrastructureRouterDeps {
  infrastructure: Pick<InfrastructureViewService, 'overview' | 'cluster' | 'clearFailures'>;
}

const viewerOf = (req: Request): Viewer => {
  const user = (req as Request & { user: { id: string; isAdmin?: boolean } }).user;
  return { id: user.id, isAdmin: Boolean(user.isAdmin) };
};

export function infrastructureRouter({ infrastructure }: InfrastructureRouterDeps): Router {
  const router = Router();

  router.get('/', asyncRoute(async (req, res) => {
    res.json(await infrastructure.overview(viewerOf(req)));
  }));

  router.get('/clusters/:id', asyncRoute(async (req, res) => {
    res.json(await infrastructure.cluster(viewerOf(req), String(req.params.id ?? '')));
  }));

  router.post('/failures/clear', asyncRoute(async (req, res) => {
    const ids = idsToClear(req.body);
    if (!ids) return res.status(400).json({ error: 'say which failures to clear as "ids", a list, or send none to clear them all' });
    return res.json({ cleared: await infrastructure.clearFailures(viewerOf(req), ids) });
  }));

  return router;
}
