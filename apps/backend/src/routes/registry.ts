import { Router, type Request } from 'express';
import { asyncRoute } from '../middleware/async-route.js';

const idOf = (req: Request): string => String(req.params.id ?? '');

const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

export function registryRouter(deps: Record<string, any>): Router {
  const { registryService } = deps;
  const router = Router();

  router.get('/search', async (req, res) => res.json(await registryService.search(req.query.q as string)));
  router.get('/tags', async (req, res) => res.json(await registryService.getTags(req.query.repo as string)));

  router.get('/tags', async (req, res) => res.json(await registryService.getTags(req.query.repo as string)));
  router.get('/local-tags', async (req, res) => res.json(await registryService.getLocalTags(req.query.repo as string)));

  router.get('/local-tags', async (req, res) => res.json(await registryService.getLocalTags(req.query.repo as string)));

  return router;
}
