import { Router, type Request } from 'express';
import { asyncRoute } from '../middleware/async-route.js';

const idOf = (req: Request): string => String(req.params.id ?? '');

const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

export function modulesRouter(deps: Record<string, any>): Router {
  const { gitModuleService } = deps;
  const router = Router();

  router.get('/', async (req, res) => res.json(await gitModuleService.listAvailableModules(req.query.appType as string)));

  return router;
}
