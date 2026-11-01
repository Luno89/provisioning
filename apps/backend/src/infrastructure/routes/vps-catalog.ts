import { asyncRoute } from '../../platform/index.js';
import { Router, type Request, type RequestHandler } from 'express';
import { vpsFiltersFrom } from '../lib/vps-catalog/filters.js';
import type { VpsCatalogService } from '../services/VpsCatalogService.js';

const userOf = (req: Request): { id: string; email: string } =>
  (req as unknown as { user: { id: string; email: string } }).user;

export interface VpsCatalogRouterDeps {
  vpsCatalogService: Pick<VpsCatalogService, 'search' | 'clearCache'>;
  operatorOnly: RequestHandler;
}

export function vpsCatalogRouter(deps: VpsCatalogRouterDeps): Router {
  const { vpsCatalogService, operatorOnly } = deps;
  const router = Router();

  router.get('/', asyncRoute(async (req, res) => {
    try {
      const read = vpsFiltersFrom(req.query);
      if ('problem' in read) return res.status(400).json({ error: read.problem });
      const result = await vpsCatalogService.search(userOf(req).id, read.filters);
      res.json(result);
    } catch (err) {
      console.error('[vps-catalog] search failed:', (err as Error).stack ?? (err as Error).message);
      res.status(500).json({ error: (err as Error).message });
    }
  }));

  router.post('/refresh', operatorOnly, asyncRoute(async (_req, res) => {
    vpsCatalogService.clearCache();
    res.json({ ok: true });
  }));

  return router;
}
