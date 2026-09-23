import type { CompactionPhase } from '../tokens/context-budget.js';
import type { ContinuityState } from '../state/state-vector.js';

export interface ContextMessage {
  role?: string | undefined;
  content?: unknown;
  toolCalls?: { id?: string | undefined; name?: string | undefined; args?: string | undefined; ok?: boolean | undefined; digest?: string | undefined }[] | undefined;
  tool_calls?: { id?: string | undefined; type?: string | undefined; function?: { name?: string | undefined; arguments?: string | undefined } | undefined }[] | undefined;
  toolCallId?: string | undefined;
  tool_call_id?: string | undefined;
  name?: string | undefined;
  reasoning?: string | undefined;
  ok?: boolean | undefined;
  at?: string | undefined;
  notice?: boolean | undefined;
  handoff?: boolean | undefined;
  [key: string]: unknown;
}

export interface CompactionResult<T extends ContextMessage = ContextMessage> {
  messages: T[];
  phase: CompactionPhase;
  pressure: number;
  originalTokens: number;
  compactedTokens: number;
  state?: ContinuityState | undefined;
}
