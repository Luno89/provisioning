import type { ChatRenderState } from '../../lib/chat-unified-reducer.js';
import type { ChatMessageData } from './ChatMessageRow.js';

export interface ChatMessageRecord extends ChatMessageData {
  handoff?: boolean | undefined;
}

/** One `data:` SSE frame at a time, shared by both scopes — they emit the exact same UnifiedFrame wire format. */
export async function readSseFrames(body: ReadableStream<Uint8Array>, onFrame: (frame: any) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ')) continue;
      const payload = trimmed.slice(6).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        onFrame(JSON.parse(payload));
      } catch { /* ignored */ }
    }
  }
}

/**
 * What's been streamed so far, turned into a real message — used both when a turn finishes
 * normally and when it's cut short (Stop, or any other mid-stream failure), so a stopped/failed
 * turn's partial text, thinking, and tool calls survive instead of vanishing with the live bubble
 * that only rendered them while `streaming` was true.
 */
export function assistantMsgFromRenderState(state: ChatRenderState): ChatMessageRecord | null {
  if (!(state.live || state.liveThinking || state.tools.length > 0 || state.interruptedReason)) return null;
  return {
    role: 'assistant',
    content: state.live,
    at: new Date().toISOString(),
    ...(state.liveThinking ? { reasoning: state.liveThinking } : {}),
    ...(state.enabled.length > 0 ? { enabled: state.enabled } : {}),
    ...(state.interruptedReason ? { interruptedReason: state.interruptedReason } : {}),
    ...(state.tools.length > 0
      ? {
          toolCalls: state.tools.map((t) => ({
            id: t.id,
            name: t.name,
            args: t.args ?? '',
            ok: t.ok ?? true,
            digest: t.digest ?? '',
          })),
        }
      : {}),
  };
}
