import type { EnvironmentSpec, ToolContract, WithheldTool } from '@koala/engine-core';
import type { SamplingConfig } from '@koala/harness-types';
import type { EgressMode } from '../agent/agent.js';
import type { RunWorkspace } from '../environment/workspace.js';

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: string;
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  toolCalls?: ToolCallRequest[] | undefined;
  toolCallId?: string | undefined;
  name?: string | undefined;
}

export interface ModelReply {
  id: string;
  content: string;
  thinking: string;
  finishReason: string;
  toolCalls: ToolCallRequest[];
}

export type Artifact =
  | { kind: 'file'; workspace: string; path: string }
  | { kind: 'link'; url: string; title?: string | undefined };

export interface ChildSteps {
  runId: string;
  agentId: string;
  outcome: string;
  reason?: string | undefined;
  steps: RunStep[];
}

export interface RunStep {
  callId: string;
  name: string;
  ok?: boolean | undefined;
  digest?: string | undefined;
  artifacts?: Artifact[] | undefined;
  child?: ChildSteps | undefined;
}

export const STEP_DIGEST_CHARS = 500;

export function collectStep(steps: RunStep[], event: { type: string; callId?: string; name?: string; ok?: boolean; digest?: string; artifacts?: Artifact[]; child?: ChildSteps }): RunStep[] {
  if (!event.callId) return steps;
  if (event.type === 'tool.called' && event.name) {
    return steps.some((step) => step.callId === event.callId) ? steps : [...steps, { callId: event.callId, name: event.name }];
  }
  if (event.type !== 'tool.result') return steps;
  return steps.map((step) => (step.callId !== event.callId ? step : {
    ...step,
    ok: event.ok === true,
    ...(event.digest ? { digest: event.digest.slice(0, STEP_DIGEST_CHARS) } : {}),
    ...(event.artifacts?.length ? { artifacts: event.artifacts } : {}),
    ...(event.child ? { child: event.child } : {}),
  }));
}

export interface ToolResult {
  forReply: string;
  callId: string;
  name: string;
  ok: boolean;
  digest: string;
  content: string;
  /** The call ran, but the peer refused it (a site that blocks fetches replying 401/403). Check Tool Failures does not count these. */
  declined?: boolean;
  artifacts?: Artifact[] | undefined;
  child?: ChildSteps | undefined;
}

export interface ModelBinding {
  providerId: string;
  label: string;
  model?: string | undefined;
  kind?: string | undefined;
  modelId?: string | undefined;
  endpointId?: string | undefined;
  contextTokens: number;
  replyCeiling?: number | undefined;
  sampling?: SamplingConfig | undefined;
  reasoningEffort?: string | undefined;
}

export type ToolSet = ToolContract[];

export type Withheld = WithheldTool[];

export type EnvironmentValue =
  | { kind: 'none'; egress: boolean; bases?: string[] | undefined }
  | { kind: 'sandbox'; id: string; workspace: RunWorkspace; capabilities: EnvironmentSpec; worktree?: string | undefined }
  | { kind: 'machine'; deviceId: string; deviceName: string; path?: string | undefined; egressMode: EgressMode };

export interface RecalledMemory {
  id: string;
  title: string;
  text: string;
  category: string;
  scope: 'project' | 'global';
}

export interface ChildOutcomeValue {
  runId: string;
  agentId: string;
  outcome: string;
  reason?: string | undefined;
  outputs: Record<string, unknown>;
  artifacts?: Artifact[] | undefined;
  steps?: RunStep[] | undefined;
}

export const replyExit = (reply: ModelReply): 'toolCalls' | 'truncated' | 'empty' | 'answered' => {
  if (reply.toolCalls.length > 0) return 'toolCalls';
  if (reply.finishReason === 'length') return 'truncated';
  if (!reply.content.trim()) return 'empty';
  return 'answered';
};

export const promptCharacters = (system: string, messages: readonly ChatMessage[] = []): number =>
  system.length + messages.reduce(
    (total, message) => total
      + message.content.length
      + (message.toolCalls ?? []).reduce((sum, call) => sum + call.name.length + call.arguments.length, 0),
    0,
  );

export interface WireMessage {
  role: ChatRole;
  content: string;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  name?: string;
}

export const toWireMessages = (system: string, messages: readonly ChatMessage[]): WireMessage[] => [
  { role: 'system', content: system },
  ...messages.map((message): WireMessage => ({
    role: message.role,
    content: message.content,
    ...(message.toolCalls && message.toolCalls.length > 0
      ? { tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: 'function' as const, function: { name: call.name, arguments: call.arguments } })) }
      : {}),
    ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
    ...(message.name && message.role === 'tool' ? { name: message.name } : {}),
  })),
];
