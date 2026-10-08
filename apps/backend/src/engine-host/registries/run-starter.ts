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
      owner: string;
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
  runId?: string | undefined;
  bound?: Record<string, string> | undefined;
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

export class AccountClosingError extends Error {
  constructor(reason: string) {
    super(`No run can start for this account: ${reason}.`);
    this.name = 'AccountClosingError';
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
  binding?: ((ownerId: string, conversationId: string) => Promise<Record<string, string> | undefined>) | undefined;
  continueAfterEvents?: number | undefined;
  closing?: ((ownerId: string) => Promise<string | undefined>) | undefined;
  turns?: {
    open(turn: { ownerId: string; conversationId: string; runId: string; message: string }): Promise<void>;
    fail(turn: { ownerId: string; conversationId: string; runId: string }, why: string): Promise<void>;
  } | undefined;
}

const savesConversation = (procedure: { nodes: readonly { kind: string }[] }): boolean => procedure.nodes.some((node) => node.kind === 'save-conversation');

export const BINDING_INPUTS = ['treeId', 'tree', 'projectId', 'project'] as const;

export function createRunStarter(options: RunStarterOptions) {
  const queue = options.taskQueue ?? DEFAULT_ENGINE_TASK_QUEUE;
  const newRunId = options.newRunId ?? (() => `run-${uuidv4()}`);

  return {
    async start(request: StartRunRequest): Promise<StartedRun> {
      const workflows = options.workflows();
      if (!workflows) throw new EngineUnavailableError();
      const closing = await options.closing?.(request.ownerId);
      if (closing) throw new AccountClosingError(closing);

      const agent = await options.registry.agent(request.ownerId, request.agentSlug);
      if (!agent) throw new UnknownAgentError(request.agentSlug);

      const runnable = await options.registry.runnable(request.ownerId, request.agentSlug, request.procedureId);
      if (!runnable) throw new UnknownProcedureError(request.procedureId ?? agent.procedure);

      const runId = request.runId ?? newRunId();

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

      const asked = Object.fromEntries(Object.entries(request.inputs ?? {})
        .filter(([name]) => !(BINDING_INPUTS as readonly string[]).includes(name)));
      const bound = request.conversationId && options.binding
        ? await options.binding(request.ownerId, request.conversationId)
        : undefined;

      const input: ProcedureRunInput = {
        ticket,
        procedure: runnable.procedure,
        inputs: {
          ...asked,
          ...(bound ?? {}),
          ...(request.bound ?? {}),
          message: request.message,
        },
        ...(options.continueAfterEvents ? { continueAfterEvents: options.continueAfterEvents } : {}),
      };

      const turn = request.conversationId && options.turns && savesConversation(runnable.procedure)
        ? { ownerId: request.ownerId, conversationId: request.conversationId, runId }
        : undefined;
      if (turn) await options.turns!.open({ ...turn, message: request.message });

      try {
        await workflows.start('AgentRunWorkflow', {
          workflowId: runId,
          taskQueue: queue,
          args: [input],
          owner: request.ownerId,
        });
      } catch (err) {
        if (turn) await options.turns!.fail(turn, `the run could not start: ${(err as Error).message}`).catch(() => undefined);
        throw err;
      }

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
