import type {
  EngineEvent,
  RunOutcome,
  EgressMode,
  RunWorkspace,
  RunBudget,
  RunIdentity,
} from '@koala/agent-engine';
import type { EnvironmentSpec } from '@koala/engine-core';
import type {
  EnvironmentValue,
  NodeTrace,
  PlacedNode,
  Procedure,
  RunContext,
  RunLaunch,
  StepResult,
  ValueResult,
} from '@koala/agent-engine/procedure';
import type { SamplingConfig } from '@koala/harness-types';

export interface RunTicket {
  runId: string;
  parentRunId?: string | undefined;
  depth: number;
  ownerId: string;
  agentSlug: string;
  conversationId?: string | undefined;
  trigger: RunIdentity['trigger'];
  modelId?: string | undefined;
  sampling?: SamplingConfig | undefined;
}

export interface ToolCallArgs {
  ticket: RunTicket;
  nodeId: string;
  name: string;
  arguments: string;
  callId?: string | undefined;
  environment?: EnvironmentHandleRef | undefined;
  granted?: string[] | undefined;
}

export interface EnvironmentHandleRef {
  id: string;
  spec: EnvironmentSpec;
  workspace?: RunWorkspace | undefined;
  scope?: { deviceId?: string | undefined; path?: string | undefined; worktree?: string | undefined } | undefined;
}

export interface ToolCallOutcome {
  ok: boolean;
  digest: string;
  content?: string | undefined;
  declined?: boolean;
}

export interface MergeArgs {
  ticket: RunTicket;
  nodeId: string;
  strategy?: string | undefined;
  children: { runId: string; agentId: string; outcome: RunOutcome; outputs: Record<string, unknown> }[];
}

export interface PublishArgs {
  events: EngineEvent[];
}

export interface AcquireEnvironmentArgs {
  ticket: RunTicket;
  spec: EnvironmentSpec;
  scope?: EnvironmentHandleRef['scope'] | undefined;
}

export interface ReleaseEnvironmentArgs {
  ticket: RunTicket;
  environmentId: string;
}

export interface AgentRunArgs {
  ticket: RunTicket;
  inputs: Record<string, unknown>;
  budget?: RunBudget | undefined;
}

export interface AgentRunOutcome {
  runId: string;
  agentId: string;
  outcome: RunOutcome;
  reason?: string | undefined;
  outputs: Record<string, unknown>;
}

export type RunEnvironment =
  | { kind: 'none'; egress: boolean; bases?: string[] | undefined }
  | {
    kind: 'sandbox';
    id: string;
    workspace: RunWorkspace;
    capabilities: EnvironmentSpec;
  }
  | {
    kind: 'machine';
    deviceId: string;
    deviceName: string;
    path?: string | undefined;
    egressMode: EgressMode;
  };

export interface ResolveEnvironmentArgs {
  ticket: RunTicket;
}

export const deviceQueue = (deviceId: string): string => `device-${deviceId}`;

export interface ResolveAgentArgs {
  ownerId: string;
  agentSlug: string;
}

export interface ResolvedAgentInfo {
  found: boolean;
  tools?: string[] | undefined;
  procedure?: Procedure | undefined;
  callableAgents: string[];
}

export interface ToolRuntime {
  run(args: ToolCallArgs): Promise<ToolCallOutcome>;
}

export interface MergeRuntime {
  run(args: MergeArgs): Promise<Record<string, unknown>>;
}

export const DEFAULT_ENGINE_TASK_QUEUE = 'engine-queue';

export const DEFAULT_STREAM_TASK_QUEUE = 'engine-stream-queue';

export type TerminalOutcome = RunOutcome;

export interface ProcedureRunInput {
  ticket: RunTicket;
  procedure: Procedure;
  inputs: Record<string, unknown>;
  projectId?: string | undefined;
}

export interface RemoteNodeRequest {
  node: PlacedNode;
  origin: string;
  inputs: Record<string, unknown>;
  previous?: Record<string, unknown> | undefined;
  execution: number;
  run: Pick<RunContext, 'identity' | 'launch' | 'inputs' | 'counters' | 'budget' | 'cleaningUp' | 'handles'>;
}

export type RemoteNodeResult = StepResult | ValueResult;

export interface RecordTracesArgs {
  ownerId: string;
  runId: string;
  agentSlug: string;
  procedureId: string;
  procedureVersion: string;
  traces: NodeTrace[];
}

export const ticketFor = (run: Pick<RunContext, 'identity' | 'launch'>): RunTicket => ({
  runId: run.identity.runId,
  ...(run.identity.parentRunId ? { parentRunId: run.identity.parentRunId } : {}),
  depth: run.identity.depth,
  ownerId: run.launch.ownerId,
  agentSlug: run.identity.agentId,
  ...(run.launch.conversationId ? { conversationId: run.launch.conversationId } : {}),
  trigger: run.identity.trigger,
  ...(run.launch.modelId ? { modelId: run.launch.modelId } : {}),
  ...(run.launch.sampling ? { sampling: run.launch.sampling } : {}),
});

export const launchFor = (ticket: RunTicket, projectId?: string): RunLaunch => ({
  ownerId: ticket.ownerId,
  ...(projectId ? { projectId } : {}),
  ...(ticket.conversationId ? { conversationId: ticket.conversationId } : {}),
  ...(ticket.modelId ? { modelId: ticket.modelId } : {}),
  ...(ticket.sampling ? { sampling: ticket.sampling } : {}),
});

export function handleFor(environment: EnvironmentValue | undefined): EnvironmentHandleRef | undefined {
  if (!environment) return undefined;
  if (environment.kind === 'sandbox') {
    return { id: environment.id, spec: environment.capabilities, workspace: environment.workspace };
  }
  if (environment.kind === 'machine') {
    return {
      id: `machine:${environment.deviceId}`,
      spec: { kind: 'machine', lifecycle: 'persistent' },
      scope: { deviceId: environment.deviceId, ...(environment.path ? { path: environment.path } : {}) },
    };
  }
  return undefined;
}

export interface SettleClaimsArgs {
  ownerId: string;
  runId: string;
  outcome: string;
  reason?: string | undefined;
}
