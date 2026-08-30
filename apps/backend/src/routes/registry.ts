import { Router } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import { clampPage, clampPageSize, parseTagSort } from '../lib/registry-tags.js';

export function registryRouter(deps: Record<string, any>): Router {
  const { registryService } = deps;
  const router = Router();

  router.get('/search', asyncRoute(async (req, res) =>
    res.json(await registryService.search(req.query.q as string))));

  router.get('/tags', asyncRoute(async (req, res) =>
    res.json(await registryService.getTagPage(req.query.repo as string, {
      page: clampPage(req.query.page),
      pageSize: clampPageSize(req.query.pageSize),
      sort: parseTagSort(req.query.sort),
    }))));

  router.get('/local-tags', asyncRoute(async (req, res) =>
    res.json(await registryService.getLocalTags(req.query.repo as string))));

  return router;
}
