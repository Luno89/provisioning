import { asyncRoute } from '../../platform/index.js';
import { Router } from 'express';
import type { GitModuleService } from '../services/GitModuleService.js';

export interface ModulesRouterDeps {
  gitModuleService: Pick<GitModuleService, 'listAvailableModules'>;
}

export function modulesRouter(deps: ModulesRouterDeps): Router {
  const { gitModuleService } = deps;
  const router = Router();

  router.get('/', asyncRoute(async (req, res) => res.json(await gitModuleService.listAvailableModules(req.query.appType as string))));

  return router;
}
