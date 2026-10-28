import type { ModelReach } from '@koala/harness-types';
import { attachmentsText, type MessageAttachment } from '../../engine/lib/attachments.js';
import { v4 as uuidv4 } from 'uuid';
import { DEFAULT_ENGINE_TASK_QUEUE, RUN_ABOUT_MEMO, RUN_AGENT_MEMO, RUN_CONVERSATION_MEMO, RUN_ID_MEMO, workflowOfRun } from '../temporal/contracts.js';
import type { SamplingConfig } from '@koala/harness-types';
import type { AgentRegistry } from './registry.js';
import { machineChoice, machineChoiceId, type MachineChoice } from '@koala/agent-engine/procedure';
import type { ProcedureRunInput, RunTicket } from '../temporal/contracts.js';
import { asPerson, memberPrincipal, type Principal } from '../../platform/lib/permissions.js';
import type { ActingFor } from '@koala/agent-engine/procedure';

export interface WorkflowStarter {
  start(
    workflowType: string,
    options: {
      workflowId: string;
      taskQueue: string;
      args: unknown[];
      owner: string;
      memo: Record<string, unknown>;
    },
  ): Promise<{ workflowId: string }>;
  signal?(workflowId: string, name: string, payload: unknown): Promise<void>;
  query?<T>(workflowId: string, name: string): Promise<T>;
}

export interface StartRunRequest {
  ownerId: string;
  actingFor?: ActingFor | undefined;
  keptTo?: string | undefined;
  agentSlug: string;
  message: string;
  inputs?: Record<string, unknown> | undefined;
  conversationId?: string | undefined;
  modelId?: string | undefined;
  modelReach?: ModelReach | undefined;
  sampling?: SamplingConfig | undefined;
  procedureId?: string | undefined;
  runId?: string | undefined;
  bound?: Record<string, string> | undefined;
  asks?: string | undefined;
  about?: string | undefined;
  attachments?: MessageAttachment[] | undefined;
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

export class MachineUnavailableError extends Error {
  constructor(reason: string) {
    super(`This run cannot go to that machine: ${reason}.`);
    this.name = 'MachineUnavailableError';
  }
}

export const MEMBERS_OFF_MACHINES = 'Koala answers a member of a shared project on its owner\'s own model, never on the owner\'s machine, and the owner\'s default model is on their machine; the owner can set a default model that is not on a machine';

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
  principal?: ((ownerId: string) => Promise<Principal>) | undefined;
  workflows: () => WorkflowStarter | undefined;
  taskQueue?: string | undefined;
  newRunId?: (() => string) | undefined;
  binding?: ((ownerId: string, conversationId: string, asker?: ActingFor | undefined) => Promise<Record<string, string> | undefined>) | undefined;
  continueAfterEvents?: number | undefined;
  closing?: ((ownerId: string) => Promise<string | undefined>) | undefined;
  machines?: ((ownerId: string, choice: MachineChoice) => Promise<string | undefined>) | undefined;
  turns?: {
    open(turn: { ownerId: string; conversationId: string; runId: string; message: string; asks?: string | undefined; askedBy?: string | undefined; attachments?: MessageAttachment[] | undefined }): Promise<void>;
    fail(turn: { ownerId: string; conversationId: string; runId: string }, why: string): Promise<void>;
  } | undefined;
}

const savesConversation = (procedure: { nodes: readonly { kind: string }[] }): boolean => procedure.nodes.some((node) => node.kind === 'save-conversation');

export const BINDING_INPUTS = ['treeId', 'tree', 'projectId', 'project', 'leafId', 'story', 'branchId', 'feature'] as const;

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

      const asked = request.actingFor && request.modelId && machineChoice(request.modelId) ? undefined : request.modelId;
      const runnable = await options.registry.runnable(request.ownerId, request.agentSlug, request.procedureId, {
        modelId: asked,
        chat: Boolean(request.conversationId),
      });
      if (!runnable) throw new UnknownProcedureError(request.procedureId ?? agent.procedure);
      if (runnable.machine && request.actingFor) throw new MachineUnavailableError(MEMBERS_OFF_MACHINES);
      if (runnable.machine) {
        if (!options.machines) throw new MachineUnavailableError('this server cannot reach people\'s machines');
        const problem = await options.machines(request.ownerId, runnable.machine);
        if (problem) throw new MachineUnavailableError(problem);
      }
      const modelId = runnable.machine ? machineChoiceId(runnable.machine) : asked;

      const runId = request.runId ?? newRunId();

      const principal = request.actingFor
        ? memberPrincipal(request.actingFor.personId, request.actingFor.projectId, request.actingFor.role)
        : await options.principal?.(request.ownerId) ?? asPerson(request.ownerId);
      const ticket: RunTicket = {
        runId,
        depth: 0,
        ownerId: request.ownerId,
        principal,
        ...(request.actingFor ? { actingFor: request.actingFor, projectId: request.actingFor.projectId } : {}),
        ...(request.keptTo && !request.actingFor ? { keptTo: request.keptTo, projectId: request.keptTo } : {}),
        agentSlug: request.agentSlug,
        ...(request.conversationId ? { conversationId: request.conversationId } : {}),
        trigger: 'user',
        ...(modelId ? { modelId } : {}),
        ...(runnable.inPlace ? { inPlace: true } : {}),
        ...(request.modelReach ? { modelReach: request.modelReach } : {}),
        ...(request.sampling ? { sampling: request.sampling } : {}),
      };

      const given = Object.fromEntries(Object.entries(request.inputs ?? {})
        .filter(([name]) => !(BINDING_INPUTS as readonly string[]).includes(name)));
      const bound = request.conversationId && options.binding
        ? await options.binding(request.ownerId, request.conversationId, request.actingFor)
        : undefined;

      const input: ProcedureRunInput = {
        ticket,
        procedure: runnable.procedure,
        inputs: {
          ...given,
          ...(bound ?? {}),
          ...(request.bound ?? {}),
          ...(request.conversationId ? { conversationId: request.conversationId } : {}),
          message: `${request.message}${attachmentsText(request.attachments)}`,
        },
        ...((request.actingFor?.projectId ?? request.keptTo) ? { projectId: request.actingFor?.projectId ?? request.keptTo } : {}),
        ...(options.continueAfterEvents ? { continueAfterEvents: options.continueAfterEvents } : {}),
      };

      const turn = request.conversationId && options.turns && savesConversation(runnable.procedure)
        ? { ownerId: request.ownerId, conversationId: request.conversationId, runId }
        : undefined;
      if (turn) await options.turns!.open({ ...turn, message: request.message, ...(request.asks ? { asks: request.asks } : {}), ...(request.actingFor ? { askedBy: request.actingFor.personId } : {}), ...(request.attachments?.length ? { attachments: request.attachments } : {}) });

      try {
        await workflows.start('AgentRunWorkflow', {
          workflowId: workflowOfRun(runId),
          taskQueue: queue,
          args: [input],
          owner: request.ownerId,
          memo: {
            [RUN_ID_MEMO]: runId,
            [RUN_AGENT_MEMO]: request.agentSlug,
            ...(request.conversationId ? { [RUN_CONVERSATION_MEMO]: request.conversationId } : {}),
            ...(request.about ? { [RUN_ABOUT_MEMO]: request.about } : {}),
          },
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
      await workflows.signal(workflowOfRun(runId), 'answer', { nodeId, value });
    },

    async approve(runId: string, callId: string, allowed: boolean, forRun = false): Promise<void> {
      const workflows = options.workflows();
      if (!workflows?.signal) throw new EngineUnavailableError();
      await workflows.signal(workflowOfRun(runId), 'approve', { callId, allowed, forRun });
    },

    async cancel(runId: string): Promise<void> {
      const workflows = options.workflows();
      if (!workflows?.signal) throw new EngineUnavailableError();
      await workflows.signal(workflowOfRun(runId), 'cancelRun', undefined);
    },
  };
}

export type RunStarter = ReturnType<typeof createRunStarter>;
