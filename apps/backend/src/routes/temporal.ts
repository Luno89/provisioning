import { Router, type Request } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import { mayTouch, seesEverything, withinQuery, workflowScope, type WorkflowViewer } from '../lib/workflow-owner.js';

interface WorkflowRow {
  workflowId: string;
  owner?: string | undefined;
  [key: string]: unknown;
}

export interface TemporalRouterDeps {
  temporalBridge: {
    isReady(): boolean;
    client?: unknown;
    listWorkflows(query?: string, pageSize?: number): Promise<WorkflowRow[]>;
    countWorkflows(query?: string): Promise<number>;
    describeWorkflow(workflowId: string): Promise<WorkflowRow | null>;
    getWorkflowHistory(workflowId: string): Promise<unknown[] | null>;
    cancelWorkflow(workflowId: string): Promise<'cancelled' | 'not-running' | 'unreachable'>;
  };
  instanceOwner?: string | undefined;
}

const viewerOf = (req: Request): WorkflowViewer =>
  (req as unknown as { user: WorkflowViewer }).user;

const askedScope = (req: Request): string | undefined => (typeof req.query.scope === 'string' ? req.query.scope : undefined);

export function temporalRouter(deps: TemporalRouterDeps): Router {
  const { temporalBridge, instanceOwner } = deps;
  const router = Router();

  const visible = async (req: Request, workflowId: string): Promise<WorkflowRow | null> => {
    const workflow = await temporalBridge.describeWorkflow(workflowId);
    return workflow && mayTouch(viewerOf(req), workflow.owner, instanceOwner) ? workflow : null;
  };

  router.get('/status', asyncRoute(async (_req, res) => {
    const ready = temporalBridge.isReady();
    let version: string | undefined;
    if (ready) {
      const service = (temporalBridge.client as { workflowService?: { getSystemInfo?: (request: object) => Promise<{ serverVersion?: string | null }> } } | undefined)?.workflowService;
      try {
        version = (await service?.getSystemInfo?.({}))?.serverVersion ?? undefined;
      } catch {
        version = undefined;
      }
    }
    res.json({ connected: ready, serverVersion: version });
  }));

  router.get('/workflows', asyncRoute(async (req, res) => {
    const viewer = viewerOf(req);
    const scope = workflowScope(viewer, askedScope(req), instanceOwner);
    const pageSize = parseInt(req.query.pageSize as string, 10) || 50;
    const workflows = await temporalBridge.listWorkflows(scope.query, pageSize);
    res.json({ workflows, all: scope.all, canSeeAll: seesEverything(viewer, instanceOwner) });
  }));

  router.get('/workflows/count', asyncRoute(async (req, res) => {
    const scope = workflowScope(viewerOf(req), askedScope(req), instanceOwner).query;
    const count = (status?: string) => temporalBridge.countWorkflows(withinQuery(scope, status) ?? '');
    const [total, running, completed, failed, timedOut] = await Promise.all([
      count(),
      count('ExecutionStatus="Running"'),
      count('ExecutionStatus="Completed"'),
      count('ExecutionStatus="Failed"'),
      count('ExecutionStatus="TimedOut"'),
    ]);
    res.json({ total, running, completed, failed, timedOut });
  }));

  router.get('/workflows/:workflowId', asyncRoute(async (req, res) => {
    const workflow = await visible(req, String(req.params.workflowId));
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' });
    return res.json({ workflow });
  }));

  router.post('/workflows/:workflowId/cancel', asyncRoute(async (req, res) => {
    const workflowId = String(req.params.workflowId);
    if (!(await visible(req, workflowId))) return res.status(404).json({ error: 'Workflow not found' });
    const outcome = await temporalBridge.cancelWorkflow(workflowId);
    if (outcome === 'unreachable') return res.status(503).json({ error: 'Temporal is not reachable' });
    if (outcome === 'not-running') return res.status(409).json({ error: 'That workflow is not running' });
    return res.status(202).json({ cancelling: true });
  }));

  router.get('/workflows/:workflowId/history', asyncRoute(async (req, res) => {
    const workflowId = String(req.params.workflowId);
    if (!(await visible(req, workflowId))) return res.status(404).json({ error: 'Workflow not found' });
    const events = await temporalBridge.getWorkflowHistory(workflowId);
    if (!events) return res.status(404).json({ error: 'Workflow not found' });
    return res.json({ events });
  }));

  return router;
}
