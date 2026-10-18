export const EXTERNAL_SEGMENT_MS = 15_000;

export interface ExternalAgentTool {
  callId: string;
  title: string;
  kind: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  input?: unknown;
  output?: string | undefined;
  paths?: string[] | undefined;
}

export type ExternalAgentWireEvent =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool'; tool: ExternalAgentTool }
  | { type: 'plan'; entries: { content: string; status: string }[] }
  | { type: 'mode'; modeId: string }
  | { type: 'stray'; callId: string; title: string; workingDir: string; folder: string };

export interface ExternalAgentAsk {
  tool: ExternalAgentTool;
  options: { optionId: string; name: string; kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' }[];
}

export interface ExternalServedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ExternalToolCall {
  callId: string;
  name: string;
  arguments: string;
}

export interface ExternalAgentModel {
  id: string;
  name: string;
}

export type ExternalAgentOp =
  | { kind: 'open'; brief: string; context?: string | undefined; mode?: string | undefined; path?: string | undefined; resume?: string | undefined; tools?: ExternalServedTool[] | undefined; model?: string | undefined }
  | { kind: 'result'; callId: string; ok: boolean; content: string }
  | { kind: 'results'; results: ExternalCallAnswer[] }
  | { kind: 'continue'; within?: number | undefined }
  | { kind: 'answer'; optionId?: string | undefined }
  | { kind: 'cancel' }
  | { kind: 'close' };

export interface ExternalCallAnswer {
  callId: string;
  ok: boolean;
  content: string;
}

export interface ExternalAgentStepArgs {
  key: string;
  agent: string;
  op: ExternalAgentOp;
}

export type ExternalAgentStepResult = {
  events: ExternalAgentWireEvent[];
  identity?: { name: string; title?: string | undefined; version?: string | undefined } | undefined;
  sessionId?: string | undefined;
  model?: ExternalAgentModel | undefined;
} & (
  | { state: 'running' }
  | { state: 'asks'; ask: ExternalAgentAsk }
  | { state: 'calls'; calls: ExternalToolCall[] }
  | { state: 'ended'; stopReason: string }
  | { state: 'failed'; error: string }
  | { state: 'closed' }
);

export const MACHINE_TREES = 'koala-trees';

export type MachineGitOp =
  | { kind: 'checkout'; repo: string; branch: string; folder: string }
  | { kind: 'push'; repo: string; branch: string; folder: string; message: string };

export type MachineGitResult = { ok: true; path: string; commit: string } | { ok: false; error: string };
