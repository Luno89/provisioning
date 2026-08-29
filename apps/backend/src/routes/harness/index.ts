import { Router } from 'express';
import { workbenchRouter, type workbenchRouterDeps } from './workbench.js';
import { authorRouter, type authorRouterDeps } from './author.js';
import { profileRouter, type profileRouterDeps } from './profile.js';
import { experimentsRouter, type experimentsRouterDeps } from './experiments.js';
import { toolsRouter, type toolsRouterDeps } from './tools.js';
import { memoriesRouter, type memoriesRouterDeps } from './memories.js';

export type HarnessRouterDeps =
  workbenchRouterDeps & authorRouterDeps & profileRouterDeps
  & experimentsRouterDeps & toolsRouterDeps & memoriesRouterDeps;

export function harnessRouter(deps: HarnessRouterDeps): Router {
  const router = Router();
  router.use('/workbench', workbenchRouter(deps));
  router.use('/author', authorRouter(deps));
  router.use('/profile', profileRouter(deps));
  router.use('/experiments', experimentsRouter(deps));
  router.use('/tools', toolsRouter(deps));
  router.use('/memories', memoriesRouter(deps));
  return router;
}
