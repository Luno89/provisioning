import { Router, type Request, type Response } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import {
  EngineUnavailableError,
  UnknownAgentError,
  UnknownProcedureError,
  type RunStarter,
  type AgentRegistry,
  blockedBy,
  isReady,
  withStatus,
  type Task,
  type TaskStatus,
} from '../engine-host/index.js';
import type { StoredNodeTrace } from '../lib/run-traces.js';
import { replyTokensProblem, samplingAt, temperatureProblem } from '../lib/run-knobs.js';

export interface TaskAccess {
  list(ownerId: string): Promise<Task[]>;
  save(task: Task): Promise<void>;
}


export interface TraceAccess {
  list(ownerId: string, runId: string): Promise<StoredNodeTrace[]>;
}

export interface EngineRouterDeps {
  runs: RunStarter;
  registry: AgentRegistry;
  traces?: TraceAccess | undefined;
  tasks?: TaskAccess | undefined;
}

const userOf = (req: Request): { id: string } =>
  (req as unknown as { user: { id: string } }).user;

const fail = (res: Response, err: unknown): Response => {
  if (err instanceof EngineUnavailableError) return res.status(503).json({ error: err.message });
  if (err instanceof UnknownAgentError) return res.status(404).json({ error: err.message });
  if (err instanceof UnknownProcedureError) return res.status(404).json({ error: err.message });
  throw err;
};

export function engineRouter(deps: EngineRouterDeps): Router {
  const router = Router();

  router.get('/agents', asyncRoute(async (req: Request, res: Response) => {
    const agents = await deps.registry.agents(userOf(req).id);
    res.json(agents.map((agent) => ({
      slug: agent.slug,
      name: agent.name,
      description: agent.description,
      loop: agent.procedure,
      tools: agent.tools,
      canDelegateTo: agent.agents ?? [],
      inputs: agent.interface?.inputs ?? null,
      mine: agent.ownerId !== undefined,
    })));
  }));

  router.get('/tasks', asyncRoute(async (req: Request, res: Response) => {
    if (!deps.tasks) return res.json([]);

    const all = await deps.tasks.list(userOf(req).id);
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const shown = status ? all.filter((task) => task.status === status) : all;

    return res.json(shown.map((task) => ({
      ...task,
      ready: isReady(task, all),
      waitingOn: blockedBy(task, all).map((dependency) => ({
        id: dependency.id,
        title: dependency.title,
        status: dependency.status,
      })),
    })));
  }));

  const decide = (status: TaskStatus) => asyncRoute(async (req: Request, res: Response) => {
    if (!deps.tasks) return res.status(503).json({ error: 'Work is not being tracked on this server.' });

    const all = await deps.tasks.list(userOf(req).id);
    const task = all.find((candidate) => candidate.id === req.params.taskId);
    if (!task) return res.status(404).json({ error: 'No such task' });

    const updated = withStatus(task, status, new Date().toISOString());
    await deps.tasks.save(updated);
    return res.json(updated);
  });

  router.post('/tasks/:taskId/accept', decide('accepted'));
  router.post('/tasks/:taskId/drop', decide('dropped'));

  router.post('/runs', asyncRoute(async (req: Request, res: Response) => {
    const { agent, message, inputs, conversationId, modelId, temperature, procedure } = req.body ?? {};

    if (typeof agent !== 'string' || !agent.trim()) {
      return res.status(400).json({ error: 'agent is required' });
    }
    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }
    const knobProblem = temperatureProblem(temperature);
    if (knobProblem) return res.status(400).json({ error: knobProblem });

    try {
      const started = await deps.runs.start({
        ownerId: userOf(req).id,
        agentSlug: agent,
        message,
        ...(inputs && typeof inputs === 'object' ? { inputs: inputs as Record<string, unknown> } : {}),
        ...(typeof conversationId === 'string' ? { conversationId } : {}),
        ...(typeof modelId === 'string' && modelId ? { modelId } : {}),
        ...(temperature === undefined ? {} : { sampling: samplingAt(temperature) }),
        ...(typeof procedure === 'string' && procedure.trim() ? { procedureId: procedure.trim() } : {}),
      });
      return res.status(201).json(started);
    } catch (err) {
      return fail(res, err);
    }
  }));

  router.get('/runs/:runId/traces', asyncRoute(async (req: Request, res: Response) => {
    const traces = deps.traces ? await deps.traces.list(userOf(req).id, String(req.params.runId)) : [];
    return res.json({ traces });
  }));

  router.post('/runs/:runId/answer', asyncRoute(async (req: Request, res: Response) => {
    const { nodeId, value } = req.body ?? {};
    if (typeof nodeId !== 'string') return res.status(400).json({ error: 'nodeId is required' });

    try {
      await deps.runs.answer(String(req.params.runId), nodeId, value);
      return res.json({ ok: true });
    } catch (err) {
      return fail(res, err);
    }
  }));

  router.post('/runs/:runId/approve', asyncRoute(async (req: Request, res: Response) => {
    const { callId, allowed, forRun } = req.body ?? {};
    if (typeof callId !== 'string') return res.status(400).json({ error: 'callId is required' });
    if (typeof allowed !== 'boolean') return res.status(400).json({ error: 'allowed must be true or false' });

    try {
      await deps.runs.approve(String(req.params.runId), callId, allowed, forRun === true);
      return res.json({ ok: true });
    } catch (err) {
      return fail(res, err);
    }
  }));

  router.post('/runs/:runId/cancel', asyncRoute(async (req: Request, res: Response) => {
    try {
      await deps.runs.cancel(String(req.params.runId));
      return res.json({ ok: true });
    } catch (err) {
      return fail(res, err);
    }
  }));

  return router;
}
