import type { EngineEvent, RunOutcome } from '../events.js';
import type { EnvironmentSpec } from '@koala/engine-core';
import type { EgressMode } from '../agent.js';
import type { RunWorkspace } from '../workspace.js';
import type { RunBudget, RunIdentity } from '../run.js';
import type { StreamToolCall } from '../stream.js';

export interface RunTicket {
  runId: string;
  parentRunId?: string | undefined;
  depth: number;
  ownerId: string;
  agentSlug: string;
  conversationId?: string | undefined;
  trigger: RunIdentity['trigger'];
}

export interface ModelCallArgs {
  ticket: RunTicket;
  nodeId: string;
  environment?: RunEnvironment | undefined;
  modelId?: string | undefined;
  tools: 'granted' | 'none';
  toolChoice?: 'none' | undefined;
  maxTokens?: number | undefined;
  reasoningEffort?: string | undefined;
  messages: { role: string; content: string }[];
}

export interface ModelCallOutcome {
  content: string;
  thinking: string;
  toolCalls: StreamToolCall[];
  finishReason: string;
  usage?: Record<string, unknown> | undefined;
  interrupted?: string | undefined;
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
  graph?: unknown;
  budget?: RunBudget | undefined;
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
