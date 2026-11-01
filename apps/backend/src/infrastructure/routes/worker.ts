import { at } from '../../platform/index.js';
import { Router, type RequestHandler } from 'express';
import type WorkerService from '../services/WorkerService.js';

export interface WorkerRouterDeps {
  workerService: Pick<WorkerService, 'status'>;
  operatorOnly: RequestHandler;
}

export function workerRouter(deps: WorkerRouterDeps): Router {
  const { workerService, operatorOnly } = deps;
  const router = Router();

  router.post('/', operatorOnly, async (req, res) => {
    try {
      const clusterId = at(req.body, 'clusterId');
      const context = at(req.body, 'context');
      if (!clusterId) return res.status(400).json({ error: 'clusterId is required' });
      console.log(`[Worker] Initialized worker ${String(clusterId)} (context: ${String(context || 'local')})`);
      res.status(202).json({
        message: 'Worker initialized',
        clusterId,
        context: context || 'local',
        state: 'running',
      });
    } catch (err) {
      console.error(`[Worker] Failed to initialize: ${(err as Error).message}`);
      res.status(503).json({ error: (err as Error).message });
    }
  });

  router.delete('/', operatorOnly, async (req, res) => {
    try {
      console.log('[Worker] Worker stopped');
      res.status(200).json({ message: 'Worker stopped' });
    } catch (err) {
      console.error(`[Worker] Failed to stop: ${(err as Error).message}`);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/', async (req, res) => {
    try {
      const state = workerService.status();
      res.json({
        clusterId: state?.clusterId || '',
        context: state?.context || 'local',
        state: state?.state || 'stopped',
        running: state?.state === 'running',
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
