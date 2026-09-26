
export interface ToolPill {
  id: string;
  name: string;
  args: string;
  running: boolean;
  ok?: boolean;
  digest?: string | undefined;
}

export interface ChatRenderState {
  live: string;
  liveThinking: string;
  tools: ToolPill[];
  interruptedReason?: string | undefined;
}

export const emptyChatRenderState: ChatRenderState = {
  live: '', liveThinking: '', tools: [],
};

export function reduceUnifiedFrames(
  state: ChatRenderState,
  frame: UnifiedFrame,
): ChatRenderState {
  if (frame.type === 'content' && 'delta' in frame) {
    const delta = frame.delta ?? '';
    return delta === '' ? state : { ...state, live: state.live + delta };
  }
  if (frame.type === 'thinking' && 'delta' in frame) {
    const delta = frame.delta ?? '';
    return delta === '' ? state : { ...state, liveThinking: state.liveThinking + delta };
  }
  if (frame.type === 'toolAnnounce' && 'payload' in frame) {
    const { id, name, args } = frame.payload as { id: string; name: string; args: string };
    const existing = state.tools.findIndex((t) => t.id === id);
    const pill: ToolPill = { id, name, args, running: true };
    const tools = existing >= 0
      ? [...state.tools.slice(0, existing), pill, ...state.tools.slice(existing + 1)]
      : [...state.tools, pill];
    return { ...state, tools };
  }
  if (frame.type === 'toolResult' && 'payload' in frame) {
    const { id, ok, digest } = frame.payload as { id: string; ok: boolean; digest?: string };
    const tools = state.tools.map((t) =>
      t.id === id ? { ...t, running: false, ok, digest } : t
    );
    return { ...state, tools };
  }
  if (frame.type === 'interrupted' && 'payload' in frame) {
    return { ...state, interruptedReason: String(frame.payload ?? '') };
  }
  return state;
}

export type UnifiedFrame =
  | { type: 'content'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'toolAnnounce'; payload: { id: string; name: string; args: string } }
  | { type: 'toolResult'; payload: { id: string; ok: boolean; digest?: string } }
  | { type: 'usage'; payload: any }
  | { type: 'interrupted'; payload: any }
  | { type: string; payload?: any };