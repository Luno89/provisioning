import type { ContextMessage } from '../compactor/compactor-types.js';

export interface KoalaChatMessage {
  role?: string;
  content?: unknown;
  toolCalls?: { id?: string; name?: string; args?: string; ok?: boolean; digest?: string }[];
  tool_calls?: { id?: string; type?: string; function?: { name?: string; arguments?: string } }[];
  toolCallId?: string;
  name?: string;
  reasoning?: string;
  at?: string;
  notice?: boolean;
  handoff?: boolean;
  [key: string]: unknown;
}

export function fromKoalaMessages(messages: readonly KoalaChatMessage[]): ContextMessage[] {
  return messages.map((m) => ({ ...m }));
}

export function toKoalaMessages<T extends KoalaChatMessage = KoalaChatMessage>(messages: readonly ContextMessage[]): T[] {
  return messages.map((m) => ({ ...m }) as unknown as T);
}
