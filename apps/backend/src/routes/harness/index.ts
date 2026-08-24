import { Router } from 'express';
import { workbenchRouter, type workbenchRouterDeps } from './workbench.js';
import { authorRouter, type authorRouterDeps } from './author.js';
import { profileRouter, type profileRouterDeps } from './profile.js';
import { experimentsRouter, type experimentsRouterDeps } from './experiments.js';
import { toolsRouter, type toolsRouterDeps } from './tools.js';
import { memoriesRouter, type memoriesRouterDeps } from './memories.js';

/**
 * `/api/harness` — the Lab's API, composed from one router per sub-resource.
 *
 * ── WHY A COMPOSITE AND NOT ONE ROUTER ──
 * `/api/harness/*` was 34 routes on one `app` object. One router for the whole prefix would be a
 * 900-line file, which is the problem being solved rather than a smaller version of it. Six
 * sub-resources, six files, each mountable and testable alone — and Express composes them, so the
 * one-router-per-prefix rule holds at the level where a route actually belongs.
 *
 * `config`, `export` and `import` stay in index.ts: they read the whole harness rather than any one
 * resource, so there is no sub-prefix they belong under.
 */
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
