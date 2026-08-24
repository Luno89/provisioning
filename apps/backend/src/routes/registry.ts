import { Router, type Request } from 'express';
import { asyncRoute } from '../middleware/async-route.js';

/** The `:id` from the path, narrowed once — Express types `req.params` loosely inside asyncRoute. */
const idOf = (req: Request): string => String(req.params.id ?? '');

/** The user `requireAuth` put on the request. */
const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

/**
 * Container registry search and tags, for the image pickers.
 */
export function registryRouter(deps: Record<string, any>): Router {
  const { registryService } = deps;
  const router = Router();

  /** ── REGISTRY ── */
  router.get('/search', async (req, res) => res.json(await registryService.search(req.query.q as string)));
  router.get('/tags', async (req, res) => res.json(await registryService.getTags(req.query.repo as string)));

  router.get('/tags', async (req, res) => res.json(await registryService.getTags(req.query.repo as string)));
  router.get('/local-tags', async (req, res) => res.json(await registryService.getLocalTags(req.query.repo as string)));

  router.get('/local-tags', async (req, res) => res.json(await registryService.getLocalTags(req.query.repo as string)));


  return router;
}
