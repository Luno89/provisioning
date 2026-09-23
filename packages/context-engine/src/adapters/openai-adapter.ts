import type { ContextMessage } from '../compactor/compactor-types.js';

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null | undefined;
  tool_calls?: {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }[] | undefined;
  tool_call_id?: string | undefined;
  name?: string | undefined;
}

export function fromOpenAIMessages(messages: readonly OpenAIMessage[]): ContextMessage[] {
  return messages.map((m) => {
    const out: ContextMessage = {
      role: m.role,
      content: m.content,
    };
    if (m.tool_calls !== undefined) out.tool_calls = m.tool_calls;
    if (m.tool_call_id !== undefined) out.toolCallId = m.tool_call_id;
    if (m.name !== undefined) out.name = m.name;
    return out;
  });
}

export function toOpenAIMessages(messages: readonly ContextMessage[]): OpenAIMessage[] {
  return messages.map((m) => {
    const out: OpenAIMessage = {
      role: (m.role as OpenAIMessage['role']) || 'user',
      content: typeof m.content === 'string' ? m.content : m.content === null ? null : JSON.stringify(m.content ?? ''),
    };
    if (m.tool_calls) {
      out.tool_calls = m.tool_calls as OpenAIMessage['tool_calls'];
    }
    const callId = m.toolCallId || (m as { tool_call_id?: string }).tool_call_id;
    if (callId) {
      out.tool_call_id = callId;
    }
    if (m.name) {
      out.name = m.name;
    }
    return out;
  });
}
