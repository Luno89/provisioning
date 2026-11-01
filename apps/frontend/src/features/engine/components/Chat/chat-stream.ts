import type { ChatRenderState } from '../../lib/chat-unified-reducer.js';
import type { ChatMessageData } from './ChatMessageRow.js';

export interface ChatMessageRecord extends ChatMessageData {
  handoff?: boolean | undefined;
}

const NOT_JSON = Symbol('not JSON');

function frameOf(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return NOT_JSON;
  }
}

/** One `data:` SSE frame at a time, shared by both scopes — they emit the exact same UnifiedFrame wire format. */
export async function readSseFrames(body: ReadableStream<Uint8Array>, onFrame: (frame: unknown) => void): Promise<void> {
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
      const frame = frameOf(payload);
      if (frame === NOT_JSON) {
        console.warn(`a stream frame was not JSON, so it was skipped: ${payload.slice(0, 200)}`);
        continue;
      }
      onFrame(frame);
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
