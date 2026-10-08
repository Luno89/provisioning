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
  Artifact,
  EnvironmentValue,
  NodeTrace,
  PlacedNode,
  Procedure,
  RunStep,
  RunCheckpoint,
  RunContext,
  RunLaunch,
  StepResult,
  ValueResult,
} from '@koala/agent-engine/procedure';
import type { SamplingConfig } from '@koala/harness-types';

export interface RunTicket {
  runId: string;
  parentRunId?: string | undefined;
  parentCallId?: string | undefined;
  turnId?: string | undefined;
  depth: number;
  ownerId: string;
  agentSlug: string;
  conversationId?: string | undefined;
  projectId?: string | undefined;
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
  artifacts?: Artifact[] | undefined;
}

export interface MergeArgs {
  ticket: RunTicket;
  nodeId: string;
  strategy?: string | undefined;
  children: { runId: string; agentId: string; outcome: RunOutcome; outputs: Record<string, unknown> }[];
}

export type LifecycleEvent =
  | { kind: 'run-started'; ownerId: string; runId: string; agentSlug: string; depth: number; conversationId?: string | undefined }
  | {
    kind: 'run-ended';
    ownerId: string;
    runId: string;
    agentSlug: string;
    outcome: string;
    reason?: string | undefined;
    ask: string;
    depth: number;
    conversationId?: string | undefined;
    leafId?: string | undefined;
  }
  | { kind: 'conversation-quiet'; ownerId: string; conversationId: string };

export const CONVERSATION_CONCLUSION_WORKFLOW = 'ConversationConclusionWorkflow';
export const CONCLUDE_WORKSPACE_WORKFLOW = 'ConcludeWorkspaceWorkflow';

export interface ConcludedWorkspace {
  kind: 'conversation' | 'tree';
  id: string;
}

export interface ConcludeWorkspaceArgs {
  ownerId: string;
  workspace: ConcludedWorkspace;
}

export const concludeWorkspaceId = (workspace: ConcludedWorkspace): string => `conclude-workspace-${workspace.kind}-${workspace.id}`;
export const BENCH_IDLE_WORKFLOW = 'BenchIdleWorkflow';
export const benchIdleId = (ownerId: string): string => `bench-idle-${ownerId}`;
export type BenchIdleOutcome = 'started' | 'busy' | 'nothing';
export const conversationConclusionId = (conversationId: string): string => `conclude-conversation-${conversationId}`;

export interface PublishArgs {
  ownerId?: string | undefined;
  turnId?: string | undefined;
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
  artifacts?: Artifact[] | undefined;
  steps?: RunStep[] | undefined;
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
  run(args: ToolCallArgs, attempt?: number): Promise<ToolCallOutcome>;
}

export interface MergeRuntime {
  run(args: MergeArgs): Promise<Record<string, unknown>>;
}

export const DEFAULT_ENGINE_TASK_QUEUE = 'engine-queue';

export const groveRunWorkflowId = (treeId: string): string => `grove-run-${treeId}`;
export const adoptionWorkflowId = (proposalId: string): string => `adopt-plan-${proposalId}`;


export const DEFAULT_STREAM_TASK_QUEUE = 'engine-stream-queue';

export type TerminalOutcome = RunOutcome;

export interface ProcedureRunInput {
  ticket: RunTicket;
  procedure: Procedure;
  inputs: Record<string, unknown>;
  projectId?: string | undefined;
  environment?: EnvironmentValue | undefined;
  continueAfterEvents?: number | undefined;
  continued?: RunContinuation | undefined;
}

export interface RunContinuation {
  checkpoint: RunCheckpoint;
  limits: { modelKey: string; modelLabel: string; limits: RunBudget };
  children: number;
  produced?: Artifact[] | undefined;
  steps?: RunStep[] | undefined;
  approvedForRun: boolean;
  approvals: [string, boolean][];
  answers: [string, unknown][];
  segment: number;
}

/** The grove run: the tree-level loop that alternates work and judge passes until the tree is quiet. */
export interface AdoptPlanArgs {
  ownerId: string;
  proposalId: string;
}

export interface AdoptPlanResult {
  proposalId: string;
  status: 'adopted' | 'failed';
  treeId?: string | undefined;
  commit?: string | undefined;
  reason?: string | undefined;
}

/** The agent that runs each stage of a tree, resolved: what its type names, and the default where it names none. */
export interface GroveRunResult {
  treeId: string;
  outcome: 'quiet' | 'stopped';
  awaitingReview: string[];
  awaitingApproval?: string[] | undefined;
}

export interface RemoteNodeRequest {
  node: PlacedNode;
  origin: string;
  inputs: Record<string, unknown>;
  previous?: Record<string, unknown> | undefined;
  execution: number;
  run: Pick<RunContext, 'identity' | 'launch' | 'inputs' | 'counters' | 'budget' | 'cleaningUp' | 'ending' | 'handles'>;
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
  ...(run.identity.parentCallId ? { parentCallId: run.identity.parentCallId } : {}),
  depth: run.identity.depth,
  ownerId: run.launch.ownerId,
  ...(run.launch.turnId && run.launch.turnId !== run.identity.runId ? { turnId: run.launch.turnId } : {}),
  agentSlug: run.identity.agentId,
  ...(run.launch.conversationId ? { conversationId: run.launch.conversationId } : {}),
  ...(run.launch.projectId ? { projectId: run.launch.projectId } : {}),
  trigger: run.identity.trigger,
  ...(run.launch.modelId ? { modelId: run.launch.modelId } : {}),
  ...(run.launch.sampling ? { sampling: run.launch.sampling } : {}),
});

export const turnOf = (ticket: Pick<RunTicket, 'runId' | 'turnId'>): string => ticket.turnId ?? ticket.runId;

export const launchFor = (ticket: RunTicket, projectId?: string): RunLaunch => ({
  ownerId: ticket.ownerId,
  turnId: turnOf(ticket),
  ...((projectId ?? ticket.projectId) ? { projectId: projectId ?? ticket.projectId } : {}),
  ...(ticket.conversationId ? { conversationId: ticket.conversationId } : {}),
  ...(ticket.modelId ? { modelId: ticket.modelId } : {}),
  ...(ticket.sampling ? { sampling: ticket.sampling } : {}),
});

export function handleFor(environment: EnvironmentValue | undefined): EnvironmentHandleRef | undefined {
  if (!environment) return undefined;
  if (environment.kind === 'sandbox') {
    return {
      id: environment.id,
      spec: environment.capabilities,
      workspace: environment.workspace,
      ...(environment.worktree ? { scope: { worktree: environment.worktree } } : {}),
    };
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

export interface ToolAllowedArgs {
  ownerId: string;
  conversationId: string;
  tool: string;
}

export interface SettleClaimsArgs {
  ownerId: string;
  runId: string;
  outcome: string;
  reason?: string | undefined;
}
