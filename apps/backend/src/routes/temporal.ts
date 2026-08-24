import { Router, type Request } from 'express';
import { asyncRoute } from '../middleware/async-route.js';

/** The `:id` from the path, narrowed once — Express types `req.params` loosely inside asyncRoute. */
const idOf = (req: Request): string => String(req.params.id ?? '');

/** The user `requireAuth` put on the request. */
const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

/**
 * Workflow inspection: what is running, what it did, and terminating one.
 */
export function temporalRouter(deps: Record<string, any>): Router {
  const { temporalBridge } = deps;
  const router = Router();

  router.get('/status', async (req, res) => {
    const ready = temporalBridge.isReady();
    let version: string | undefined;
    if (ready) {
      try {
        const svc = (temporalBridge as any).client.workflowService;
        const info = await svc?.getSystemInfo?.();
        version = info?.serverVersion;
      } catch {}
    }
    res.json({ connected: ready, serverVersion: version });
  });

  router.get('/workflows', async (req, res) => {
    const query = req.query.query as string | undefined;
    const pageSize = parseInt(req.query.pageSize as string, 10) || 50;
    const workflows = await temporalBridge.listWorkflows(query, pageSize);
    res.json({ workflows });
  });

  router.get('/workflows/count', async (req, res) => {
    const [total, running, completed, failed, timedOut] = await Promise.all([
      temporalBridge.countWorkflows(''),
      temporalBridge.countWorkflows('ExecutionStatus="Running"'),
      temporalBridge.countWorkflows('ExecutionStatus="Completed"'),
      temporalBridge.countWorkflows('ExecutionStatus="Failed"'),
      temporalBridge.countWorkflows('ExecutionStatus="TimedOut"'),
    ]);
    res.json({ total, running, completed, failed, timedOut });
  });

  router.get('/workflows/:workflowId', async (req, res) => {
    const workflow = await temporalBridge.describeWorkflow(req.params.workflowId);
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' });
    res.json({ workflow });
  });

  router.get('/workflows/:workflowId/history', async (req, res) => {
    const events = await temporalBridge.getWorkflowHistory(req.params.workflowId);
    if (!events) return res.status(404).json({ error: 'Workflow not found' });
    res.json({ events });
  });

  return router;
}
