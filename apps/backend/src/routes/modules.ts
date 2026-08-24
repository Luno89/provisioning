import { Router, type Request } from 'express';
import { asyncRoute } from '../middleware/async-route.js';

/** The `:id` from the path, narrowed once — Express types `req.params` loosely inside asyncRoute. */
const idOf = (req: Request): string => String(req.params.id ?? '');

/** The user `requireAuth` put on the request. */
const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

/**
 * Git modules available for an app type. Odoo is the only one that uses them today.
 */
export function modulesRouter(deps: Record<string, any>): Router {
  const { gitModuleService } = deps;
  const router = Router();

  /** ── MODULES ── */
  router.get('/', async (req, res) => res.json(await gitModuleService.listAvailableModules(req.query.appType as string)));


  return router;
}
