import type { Artifact, ChildSteps, RunStep } from '@koala/agent-engine/procedure'

export interface ToolPill {
  id: string;
  name: string;
  args: string;
  running: boolean;
  ok?: boolean;
  digest?: string | undefined;
  artifacts?: Artifact[] | undefined;
  child?: ChildRunView | undefined;
}

export interface ChildRunView {
  runId: string;
  agentId: string;
  running: boolean;
  outcome?: string | undefined;
  reason?: string | undefined;
  live: string;
  tools: ToolPill[];
}

export function childFromSteps(child: ChildSteps): ChildRunView {
  const pill = (step: RunStep): ToolPill => ({
    id: step.callId,
    name: step.name,
    args: '',
    running: false,
    ok: step.ok === true,
    ...(step.digest ? { digest: step.digest } : {}),
    ...(step.artifacts?.length ? { artifacts: step.artifacts } : {}),
    ...(step.child ? { child: childFromSteps(step.child) } : {}),
  });
  return {
    runId: child.runId,
    agentId: child.agentId,
    running: false,
    outcome: child.outcome,
    ...(child.reason ? { reason: child.reason } : {}),
    live: '',
    tools: child.steps.map(pill),
  };
}

export const childView = (child: ChildRunView | ChildSteps): ChildRunView => ('steps' in child ? childFromSteps(child) : child);

const atPath = (tools: ToolPill[], path: readonly string[], change: (pill: ToolPill) => ToolPill, missing?: (id: string) => ToolPill): ToolPill[] => {
  const [head, ...rest] = path;
  if (rest.length === 0 && missing && head !== undefined && !tools.some((pill) => pill.id === head)) return [...tools, change(missing(head))];
  return tools.map((pill) => {
    if (pill.id !== head) return pill;
    if (rest.length === 0) return change(pill);
    if (!pill.child) return pill;
    return { ...pill, child: { ...pill.child, tools: atPath(pill.child.tools, rest, change, missing) } };
  });
};

const reduceChild = (child: ChildRunView, frame: UnifiedFrame): ChildRunView => {
  const inner = reduceUnifiedFrames({ live: child.live, liveThinking: '', tools: child.tools }, frame);
  return { ...child, live: inner.live, tools: inner.tools };
};

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
    const earlier = existing >= 0 ? state.tools[existing] : undefined;
    const pill: ToolPill = { id, name, args, running: true, ...(earlier?.child ? { child: earlier.child } : {}) };
    const tools = existing >= 0
      ? [...state.tools.slice(0, existing), pill, ...state.tools.slice(existing + 1)]
      : [...state.tools, pill];
    return { ...state, tools };
  }
  if (frame.type === 'toolResult' && 'payload' in frame) {
    const { id, ok, digest, artifacts, child } = frame.payload as { id: string; ok: boolean; digest?: string; artifacts?: Artifact[]; child?: ChildSteps };
    const tools = state.tools.map((t) =>
      t.id === id ? { ...t, running: false, ok, digest, ...(artifacts?.length ? { artifacts } : {}), ...(child ? { child: childFromSteps(child) } : {}) } : t
    );
    return { ...state, tools };
  }
  if (frame.type === 'childStarted' && 'payload' in frame) {
    const { path, runId, agentId } = frame.payload as { path: string[]; runId: string; agentId: string };
    return {
      ...state,
      tools: atPath(
        state.tools,
        path,
        (pill) => ({ ...pill, child: pill.child?.runId === runId ? pill.child : { runId, agentId, running: true, live: '', tools: [] } }),
        (id) => ({ id, name: agentId, args: '', running: true }),
      ),
    };
  }
  if (frame.type === 'childFrame' && 'payload' in frame) {
    const { path, frame: inner } = frame.payload as { path: string[]; frame: UnifiedFrame };
    return { ...state, tools: atPath(state.tools, path, (pill) => (pill.child ? { ...pill, child: reduceChild(pill.child, inner) } : pill)) };
  }
  if (frame.type === 'childFinished' && 'payload' in frame) {
    const { path, outcome, reason } = frame.payload as { path: string[]; outcome: string; reason?: string };
    return { ...state, tools: atPath(state.tools, path, (pill) => (pill.child ? { ...pill, child: { ...pill.child, running: false, outcome, ...(reason ? { reason } : {}) } } : pill)) };
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
  | { type: 'toolResult'; payload: { id: string; ok: boolean; digest?: string; artifacts?: Artifact[]; child?: ChildSteps } }
  | { type: 'childStarted'; payload: { path: string[]; runId: string; agentId: string } }
  | { type: 'childFrame'; payload: { path: string[]; frame: UnifiedFrame } }
  | { type: 'childFinished'; payload: { path: string[]; outcome: string; reason?: string } }
  | { type: 'usage'; payload: unknown }
  | { type: 'interrupted'; payload: unknown }
  | { type: string; payload?: unknown };