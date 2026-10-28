import { Router, type Request } from 'express';
import { asyncRoute, principalFrom } from '../../platform/index.js';
import { isRange, type Range } from '../lib/monitoring-questions.js';
import { type MonitoringService, type Viewer } from '../services/MonitoringService.js';

export interface MonitoringRouterDeps {
  monitoring: MonitoringService;
}

const viewerOf = (req: Request): Viewer => principalFrom(req);

const idOf = (req: Request): string => String(req.params.id ?? '');

const rangeOf = (value: unknown): Range => (isRange(value) ? value : '24h');

export function monitoringRouter({ monitoring }: MonitoringRouterDeps): Router {
  const router = Router();

  router.get('/', asyncRoute(async (req, res) => {
    res.json(await monitoring.overview(viewerOf(req)));
  }));

  router.get('/alerts', asyncRoute(async (req, res) => {
    res.json(await monitoring.alerts(viewerOf(req)));
  }));

  router.get('/apps/:id', asyncRoute(async (req, res) => {
    res.json(await monitoring.appHealth(viewerOf(req), idOf(req), rangeOf(req.query.range)));
  }));

  router.get('/clusters/:id', asyncRoute(async (req, res) => {
    res.json(await monitoring.clusterHealth(viewerOf(req), idOf(req), rangeOf(req.query.range)));
  }));

  router.put('/clusters/:id/history', asyncRoute(async (req, res) => {
    res.json(await monitoring.setHistory(viewerOf(req), idOf(req), (req.body as { days?: unknown } | undefined)?.days));
  }));

  router.delete('/rules/:id', asyncRoute(async (req, res) => {
    await monitoring.removeRule(viewerOf(req), idOf(req));
    res.status(204).end();
  }));

  return router;
}
