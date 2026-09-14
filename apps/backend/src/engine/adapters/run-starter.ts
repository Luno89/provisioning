import { v4 as uuidv4 } from 'uuid';
import { DEFAULT_ENGINE_TASK_QUEUE } from '../temporal/contracts.js';
import type { AgentRegistry } from './registry.js';
import type { RunTicket } from '../temporal/contracts.js';

export interface WorkflowStarter {
  start(
    workflowType: string,
    options: {
      workflowId: string;
      taskQueue: string;
      args: unknown[];
    },
  ): Promise<{ workflowId: string }>;
  signal?(workflowId: string, name: string, payload: unknown): Promise<void>;
  query?<T>(workflowId: string, name: string): Promise<T>;
}

export interface StartRunRequest {
  ownerId: string;
  agentSlug: string;
  message: string;
  inputs?: Record<string, unknown> | undefined;
  conversationId?: string | undefined;
}

export interface StartedRun {
  runId: string;
  agentSlug: string;
  loopId: string;
}

export class EngineUnavailableError extends Error {
  constructor() {
    super('The engine is not connected to Temporal, so runs cannot be started right now.');
    this.name = 'EngineUnavailableError';
  }
}

export class UnknownAgentError extends Error {
  constructor(slug: string) {
    super(`There is no agent called "${slug}".`);
    this.name = 'UnknownAgentError';
  }
}

export interface RunStarterOptions {
  registry: AgentRegistry;
  workflows: () => WorkflowStarter | undefined;
  taskQueue?: string | undefined;
  newRunId?: (() => string) | undefined;
}

export function createRunStarter(options: RunStarterOptions) {
  const queue = options.taskQueue ?? DEFAULT_ENGINE_TASK_QUEUE;
  const newRunId = options.newRunId ?? (() => `run-${uuidv4()}`);

  return {
    async start(request: StartRunRequest): Promise<StartedRun> {
      const workflows = options.workflows();
      if (!workflows) throw new EngineUnavailableError();

      const runnable = await options.registry.runnable(request.ownerId, request.agentSlug);
      if (!runnable) throw new UnknownAgentError(request.agentSlug);

      const callable = await options.registry.callable(request.ownerId, request.agentSlug);
      const runId = newRunId();

      const ticket: RunTicket = {
        runId,
        depth: 0,
        ownerId: request.ownerId,
        agentSlug: request.agentSlug,
        ...(request.conversationId ? { conversationId: request.conversationId } : {}),
        trigger: 'user',
      };

      await workflows.start('AgentRunWorkflow', {
        workflowId: runId,
        taskQueue: queue,
        args: [{
          ticket,
          graph: runnable.graph,
          budget: runnable.agent.budget,
          messages: [{ role: 'user', content: request.message }],
          inputs: request.inputs ?? {},
          callableAgents: callable.map((agent) => agent.slug),
          granted: runnable.agent.tools,
        }],
      });

      return { runId, agentSlug: request.agentSlug, loopId: runnable.graph.id };
    },

    async answer(runId: string, nodeId: string, value: unknown): Promise<void> {
      const workflows = options.workflows();
      if (!workflows?.signal) throw new EngineUnavailableError();
      await workflows.signal(runId, 'answer', { nodeId, value });
    },

    async approve(runId: string, callId: string, allowed: boolean, forRun = false): Promise<void> {
      const workflows = options.workflows();
      if (!workflows?.signal) throw new EngineUnavailableError();
      await workflows.signal(runId, 'approve', { callId, allowed, forRun });
    },

    async cancel(runId: string): Promise<void> {
      const workflows = options.workflows();
      if (!workflows?.signal) throw new EngineUnavailableError();
      await workflows.signal(runId, 'cancelRun', undefined);
    },
  };
}

export type RunStarter = ReturnType<typeof createRunStarter>;
