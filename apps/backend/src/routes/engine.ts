import type { ExtensionService, ExtensionState } from '../services/ExtensionService.js';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import type { ApprovalService } from '../services/ApprovalService.js';
import {
  AccountClosingError,
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
import type { WorkspaceImage } from '../engine-host/sandboxes/warm-images.js';
import type { PruneReport } from '../engine-host/sandboxes/prune-images.js';
import { SwitchedOffError } from '../lib/extension-settings.js';
import { replyTokensProblem, samplingAt, temperatureProblem } from '../lib/run-knobs.js';

export interface TaskAccess {
  list(ownerId: string): Promise<Task[]>;
  save(task: Task): Promise<void>;
}


export interface TraceAccess {
  list(ownerId: string, runId: string): Promise<StoredNodeTrace[]>;
}

/** What the workspace images are, and the sweep that lets go of the ones nothing would run. */
export interface WorkspaceImageAccess {
  standing(ownerId?: string): Promise<WorkspaceImage[]>;
  /** Nothing to sweep with, where there is no registry account to delete through. */
  prune(): Promise<PruneReport | undefined>;
}

export interface EngineRouterDeps {
  runs: RunStarter;
  approvals: Pick<ApprovalService, 'approve'>;
  registry: AgentRegistry;
  traces?: TraceAccess | undefined;
  tasks?: TaskAccess | undefined;
  images?: WorkspaceImageAccess | undefined;
  /** Deleting images is everybody's business, so only an administrator starts a sweep by hand. */
  admin?: RequestHandler | undefined;
  extensions?: Pick<ExtensionService, 'list' | 'setEnabled' | 'create' | 'update' | 'remove' | 'publish' | 'removeOperation'> | undefined;
}

const userOf = (req: Request): { id: string } =>
  (req as unknown as { user: { id: string } }).user;

const fail = (res: Response, err: unknown): Response => {
  if (err instanceof EngineUnavailableError) return res.status(503).json({ error: err.message });
  if (err instanceof AccountClosingError) return res.status(409).json({ error: err.message });
  if (err instanceof UnknownAgentError) return res.status(404).json({ error: err.message });
  if (err instanceof UnknownProcedureError) return res.status(404).json({ error: err.message });
  if (err instanceof SwitchedOffError) return res.status(409).json({ error: err.message, code: 'SWITCHED_OFF' });
  throw err;
};

export function engineRouter(deps: EngineRouterDeps): Router {
  const router = Router();

  const summary = ({ extension, enabled, alwaysOn, authored, latest }: ExtensionState) => ({
    id: extension.id,
    title: extension.title,
    describe: extension.describe,
    version: extension.version,
    enabled,
    alwaysOn,
    authored,
    ...(latest ? { latest } : {}),
    requires: extension.requires ?? [],
    operations: extension.operations ?? [],
    groups: extension.groups ?? [],
    tools: (extension.tools ?? []).map((tool) => tool.name),
    personas: (extension.personas ?? []).map((persona) => persona.slug),
    procedures: (extension.procedures ?? []).map((procedure) => procedure.id),
  });

  router.get('/extensions', asyncRoute(async (req: Request, res: Response) => {
    res.json(deps.extensions ? (await deps.extensions.list(userOf(req).id)).map(summary) : []);
  }));

  type Outcome<T> = { ok: true; value: T } | { ok: false; status: number; error: string };
  const answer = <T>(res: Response, outcome: Outcome<T>, shape: (value: T) => unknown = (value) => value) =>
    (outcome.ok ? res.json(shape(outcome.value)) : res.status(outcome.status).json({ error: outcome.error }));
  const listed = (states: ExtensionState[]) => states.map(summary);
  const own = (res: Response) => {
    if (deps.extensions) return deps.extensions;
    res.status(503).json({ error: 'extensions are not available here' });
    return undefined;
  };

  router.post('/extensions', asyncRoute(async (req: Request, res: Response) => {
    const extensions = own(res);
    if (!extensions) return;
    const body = (req.body ?? {}) as { id?: unknown; title?: unknown; describe?: unknown };
    answer(res, await extensions.create(userOf(req).id, { id: String(body.id ?? ''), title: String(body.title ?? ''), describe: typeof body.describe === 'string' ? body.describe : undefined }), listed);
  }));

  router.put('/extensions/:id', asyncRoute(async (req: Request, res: Response) => {
    const extensions = own(res);
    if (!extensions) return;
    answer(res, await extensions.update(userOf(req).id, String(req.params.id), (req.body ?? {}) as never), listed);
  }));

  router.delete('/extensions/:id', asyncRoute(async (req: Request, res: Response) => {
    const extensions = own(res);
    if (!extensions) return;
    answer(res, await extensions.remove(userOf(req).id, String(req.params.id)), listed);
  }));

  router.post('/extensions/:id/operations', asyncRoute(async (req: Request, res: Response) => {
    const extensions = own(res);
    if (!extensions) return;
    const body = (req.body ?? {}) as { name?: unknown; group?: unknown };
    if (!body.group || typeof body.group !== 'object') return res.status(400).json({ error: 'send the group to publish as "group"' });
    return answer(res, await extensions.publish(userOf(req).id, String(req.params.id), String(body.name ?? ''), body.group as never));
  }));

  router.delete('/extensions/:id/operations/:name', asyncRoute(async (req: Request, res: Response) => {
    const extensions = own(res);
    if (!extensions) return;
    answer(res, await extensions.removeOperation(userOf(req).id, String(req.params.id), String(req.params.name)), listed);
  }));

  router.put('/extensions/:id/enabled', asyncRoute(async (req: Request, res: Response) => {
    if (!deps.extensions) return res.status(503).json({ error: 'extensions are not available here' });
    const enabled = (req.body as { enabled?: unknown } | undefined)?.enabled;
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'say whether the extension is enabled, as true or false' });
    const outcome = await deps.extensions.setEnabled(userOf(req).id, String(req.params.id), enabled);
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    return res.json(outcome.value.map(summary));
  }));

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
    const { callId, allowed, forRun, conversationId, tool } = req.body ?? {};
    if (typeof callId !== 'string') return res.status(400).json({ error: 'callId is required' });
    if (typeof allowed !== 'boolean') return res.status(400).json({ error: 'allowed must be true or false' });
    const conversation = typeof conversationId === 'string' && typeof tool === 'string' && tool ? { id: conversationId, tool } : undefined;

    try {
      const outcome = await deps.approvals.approve(userOf(req).id, String(req.params.runId), { callId, allowed, forRun: forRun === true, conversation });
      if (outcome === 'not-yours') return res.status(404).json({ error: 'You have no run with that id' });
      if (outcome === 'no-such-conversation') return res.status(404).json({ error: 'You have no conversation with that id' });
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

  router.get('/images', asyncRoute(async (req: Request, res: Response) => {
    if (!deps.images) return res.status(404).json({ error: 'Workspace images are not wired here' });
    return res.json({ images: await deps.images.standing(userOf(req).id) });
  }));

  if (deps.images && deps.admin) {
    const images = deps.images;
    router.post('/images/prune', deps.admin, asyncRoute(async (_req: Request, res: Response) => {
      const report = await images.prune();
      if (!report) return res.status(501).json({ error: 'There is no registry account, so there is nothing to sweep' });
      return res.json({ report });
    }));
  }

  return router;
}
