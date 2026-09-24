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
  environment?: EnvironmentValue | undefined;
}

/** The grove run: the tree-level loop that alternates work and judge passes until the tree is quiet. */
export interface GroveRunArgs {
  treeId: string;
  ownerId: string;
  /** hard cap on passes; when the tree is still moving at the cap, the run reports capped instead of crashing */
  maxPasses?: number | undefined;
}

export interface GrovePartitionArgs {
  treeId: string;
  ownerId: string;
}

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

export interface GrovePrepareWorkArgs {
  treeId: string;
  ownerId: string;
  leafIds: string[];
}

export interface GrovePreparedWork {
  ready: string[];
  failed: { leafId: string; reason: string }[];
}

export interface GroveJudgeCheckoutArgs {
  treeId: string;
  ownerId: string;
  leafIds: string[];
}

export type GroveJudgeCheckouts = Record<string, string | undefined>;

export interface GroveLeafArgs {
  treeId: string;
  ownerId: string;
  leafId: string;
  leafTitle: string;
  runId: string;
  environment: EnvironmentValue;
  siblings?: string | undefined;
}

export interface GroveLeafResult {
  leafId: string;
  outcome: 'claimed' | 'failed' | 'unbroken';
  reason?: string | undefined;
}

export interface GroveLeafTasksArgs {
  ownerId: string;
  leafId: string;
}

export interface GroveLeafTaskView {
  id: string;
  title: string;
  status: import('../../lib/tasks.js').TaskStatus;
  dependsOn: string[];
  doneMeans: string;
  description?: string | undefined;
  role?: string | undefined;
  checks?: import('../../lib/tasks.js').TaskChecks | undefined;
  evidence?: string | undefined;
  runs?: string[] | undefined;
}

export interface GroveClaimArgs {
  treeId: string;
  ownerId: string;
  leafId: string;
  result: 'claimed' | 'failed';
  reason?: string | undefined;
}

export interface GroveClaimOutcome {
  ok: boolean;
  digest: string;
}

export interface GroveWorkspaceArgs {
  treeId: string;
  ownerId: string;
}

export interface GrovePartitionLeaf {
  id: string;
  title: string;
  body: string;
  branchId: string;
}

export interface GroveClaim {
  evidence: string;
  commit?: string | undefined;
  findings?: string | undefined;
  runs?: string[] | undefined;
  at: string;
}

export interface GrovePartition {
  ready: GrovePartitionLeaf[];
  claimed: (GrovePartitionLeaf & { claim?: GroveClaim | undefined })[];
  awaitingReview: { id: string; title: string; review?: string | undefined }[];
  settledCount: number;
}

export interface GroveRunResult {
  treeId: string;
  outcome: 'quiet' | 'capped';
  passes: number;
  awaitingReview: string[];
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

export interface SettleClaimsArgs {
  ownerId: string;
  runId: string;
  outcome: string;
  reason?: string | undefined;
}
