import { Router } from 'express';

export function modulesRouter(deps: Record<string, any>): Router {
  const { gitModuleService } = deps;
  const router = Router();

  router.get('/', async (req, res) => res.json(await gitModuleService.listAvailableModules(req.query.appType as string)));

  return router;
}
