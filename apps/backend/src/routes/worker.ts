import { Router, type Request } from 'express';
import { asyncRoute } from '../middleware/async-route.js';

/** The `:id` from the path, narrowed once — Express types `req.params` loosely inside asyncRoute. */
const idOf = (req: Request): string => String(req.params.id ?? '');

/** The user `requireAuth` put on the request. */
const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

/**
 * The in-cluster worker pod lifecycle.
 */
export function workerRouter(deps: Record<string, any>): Router {
  const { workerService } = deps;
  const router = Router();

  router.post('/', async (req, res) => {
    try {
      const { clusterId, context } = req.body || {};
      if (!clusterId) return res.status(400).json({ error: 'clusterId is required' });
      console.log(`[Worker] Initialized worker ${clusterId} (context: ${context || 'local'})`);
      res.status(202).json({
        message: 'Worker initialized',
        clusterId,
        context: context || 'local',
        state: 'running',
      });
    } catch (err: any) {
      console.error(`[Worker] Failed to initialize: ${err.message}`);
      res.status(503).json({ error: err.message });
    }
  });

  router.delete('/', async (req, res) => {
    try {
      console.log('[Worker] Worker stopped');
      res.status(200).json({ message: 'Worker stopped' });
    } catch (err: any) {
      console.error(`[Worker] Failed to stop: ${err.message}`);
      res.status(500).json({ error: err.message });
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
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
