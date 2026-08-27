/* ═══════════════ Unified chat frame → render state reducer ═══════════════ */

/**
 * Pure reducer: a stream of backend unified frames → minimal render state.
 *
 * The backend emits frames: {type:'content',delta}, {type:'thinking',delta},
 * {type:'toolAnnounce',payload:{id,name,args}}, {type:'toolResult',payload:{id,ok,digest}},
 * {type:'enabled',payload:string[]}, {type:'proposedTree'|'proposedSpec',payload},
 * {type:'plan',payload}, {type:'usage',payload}, {type:'interrupted',payload}
 *
 * This reducer is shared by any chat surface (workbench, koala, etc.). No React, no side effects.
 */

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
  enabled: string[];
  proposals: Array<{ kind: string; payload: any }>;
}

export const emptyChatRenderState: ChatRenderState = {
  live: '', liveThinking: '', tools: [], enabled: [], proposals: [],
};

/**
 * Apply one unified frame to the render state. Returns a new state (immutable).
 */
export function reduceUnifiedFrames(
  state: ChatRenderState,
  frame: UnifiedFrame,
): ChatRenderState {
  // Narrow the frame first so TS tracks payload in each branch
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
  if (frame.type === 'enabled' && 'payload' in frame) {
    const svcs = frame.payload as string[];
    return { ...state, enabled: [...new Set([...state.enabled, ...svcs])] };
  }
  if ((frame.type === 'proposedTree' || frame.type === 'proposedSpec' || frame.type === 'proposedEscalation' || frame.type === 'proposedSecretRequest') && 'payload' in frame) {
    const kind = frame.type === 'proposedTree' ? 'tree' : frame.type === 'proposedSpec' ? 'spec' : frame.type === 'proposedEscalation' ? 'escalation' : 'secretRequest';
    const proposals = [...state.proposals, { kind, payload: frame.payload }];
    return { ...state, proposals };
  }
  return state;
}

/** All frames the backend can emit (kept here so surfaces don't need to import backend types). */
export type UnifiedFrame =
  | { type: 'content'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'toolAnnounce'; payload: { id: string; name: string; args: string } }
  | { type: 'toolResult'; payload: { id: string; ok: boolean; digest?: string } }
  | { type: 'enabled'; payload: string[] }
  | { type: 'proposedTree'; payload: any }
  | { type: 'proposedSpec'; payload: any }
  | { type: 'proposedEscalation'; payload: any }
  | { type: 'proposedSecretRequest'; payload: any }
  | { type: 'plan'; payload: any }
  | { type: 'usage'; payload: any }
  | { type: 'interrupted'; payload: any }
  | { type: string; payload?: any };