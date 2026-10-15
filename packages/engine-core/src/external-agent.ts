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

export type ExternalAgentOp =
  | { kind: 'open'; brief: string; context?: string | undefined; mode?: string | undefined; path?: string | undefined; resume?: string | undefined }
  | { kind: 'continue' }
  | { kind: 'answer'; optionId?: string | undefined }
  | { kind: 'cancel' }
  | { kind: 'close' };

export interface ExternalAgentStepArgs {
  key: string;
  agent: string;
  op: ExternalAgentOp;
}

export type ExternalAgentStepResult = {
  events: ExternalAgentWireEvent[];
  identity?: { name: string; title?: string | undefined; version?: string | undefined } | undefined;
  sessionId?: string | undefined;
} & (
  | { state: 'running' }
  | { state: 'asks'; ask: ExternalAgentAsk }
  | { state: 'ended'; stopReason: string }
  | { state: 'failed'; error: string }
  | { state: 'closed' }
);
