import { v4 as uuidv4 } from 'uuid';
import { DEFAULT_ENGINE_TASK_QUEUE } from '../temporal/contracts.js';
import type { SamplingConfig } from '@koala/harness-types';
import type { AgentRegistry } from './registry.js';
import type { ProcedureRunInput, RunTicket } from '../temporal/contracts.js';

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
  modelId?: string | undefined;
  sampling?: SamplingConfig | undefined;
  procedureId?: string | undefined;
}

export interface StartedRun {
  runId: string;
  agentSlug: string;
  loopId: string;
}

export class UnknownProcedureError extends Error {
  constructor(id: string) {
    super(`There is no procedure called "${id}".`);
    this.name = 'UnknownProcedureError';
  }
}

export class EngineUnavailableError extends Error {
  constructor() {
    super('The engine is not connected to Temporal, so runs cannot be started right now.');
    this.name = 'EngineUnavailableError';
  }
}

import { UnknownAgentError } from './endpoints.js';
export { UnknownAgentError };

export interface RunStarterOptions {
  registry: AgentRegistry;
  workflows: () => WorkflowStarter | undefined;
  taskQueue?: string | undefined;
  newRunId?: (() => string) | undefined;
  boundTree?: ((ownerId: string, conversationId: string) => Promise<BoundTree | undefined>) | undefined;
}

export interface BoundTree {
  treeId: string;
  outline: string;
}

export function createRunStarter(options: RunStarterOptions) {
  const queue = options.taskQueue ?? DEFAULT_ENGINE_TASK_QUEUE;
  const newRunId = options.newRunId ?? (() => `run-${uuidv4()}`);

  return {
    async start(request: StartRunRequest): Promise<StartedRun> {
      const workflows = options.workflows();
      if (!workflows) throw new EngineUnavailableError();

      const agent = await options.registry.agent(request.ownerId, request.agentSlug);
      if (!agent) throw new UnknownAgentError(request.agentSlug);

      const runnable = await options.registry.runnable(request.ownerId, request.agentSlug, request.procedureId);
      if (!runnable) throw new UnknownProcedureError(request.procedureId ?? agent.procedure);

      const runId = newRunId();

      const ticket: RunTicket = {
        runId,
        depth: 0,
        ownerId: request.ownerId,
        agentSlug: request.agentSlug,
        ...(request.conversationId ? { conversationId: request.conversationId } : {}),
        trigger: 'user',
        ...(request.modelId ? { modelId: request.modelId } : {}),
        ...(request.sampling ? { sampling: request.sampling } : {}),
      };

      const { treeId: _claimedTree, tree: _claimedOutline, ...asked } = request.inputs ?? {};
      const bound = request.conversationId && options.boundTree
        ? await options.boundTree(request.ownerId, request.conversationId)
        : undefined;

      const input: ProcedureRunInput = {
        ticket,
        procedure: runnable.procedure,
        inputs: {
          ...asked,
          ...(bound ? { treeId: bound.treeId, tree: bound.outline } : {}),
          message: request.message,
        },
      };

      await workflows.start('AgentRunWorkflow', {
        workflowId: runId,
        taskQueue: queue,
        args: [input],
      });

      return { runId, agentSlug: request.agentSlug, loopId: runnable.procedure.id };
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
