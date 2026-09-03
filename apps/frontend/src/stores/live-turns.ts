import { create } from 'zustand';
import { reduceUnifiedFrames, emptyChatRenderState, type ChatRenderState } from '../lib/chat-unified-reducer.js';
import type { ChatMessageData } from '../components/Chat/ChatMessageRow.js';

export type TurnStatus = 'streaming' | 'done' | 'error';

export type LiveTurn =
  | { kind: 'conversation'; renderState: ChatRenderState; status: TurnStatus }
  | { kind: 'branch'; trailing: ChatMessageData; status: TurnStatus };

export const conversationTurnKey = (conversationId: string): string => `conversation:${conversationId}`;
export const branchTurnKey = (branchId: string): string => `branch:${branchId}`;

interface LiveTurnsState {
  turns: Record<string, LiveTurn>;
  startConversation: (key: string) => void;
  applyFrame: (key: string, frame: unknown) => ChatRenderState;
  startBranch: (key: string) => void;
  appendBranchDelta: (
    key: string,
    delta: { content?: string | undefined; reasoning?: string | undefined; interruptedReason?: string | undefined },
  ) => ChatMessageData;
  finish: (key: string, status: 'done' | 'error') => void;
}

/**
 * Ephemeral SSE-stream accumulation, keyed by conversation/branch id, decoupled from any
 * component's lifecycle — a view swap in App.tsx fully unmounts the chat subtree, but the
 * `readSseFrames` loop that's already reading the stream keeps running as an orphaned promise
 * regardless. Writing into this store instead of component state means that loop's progress
 * survives the unmount, and whichever component remounts for that id picks up where it left off.
 *
 * A turn is left in place (status 'done'/'error') rather than removed on completion — for branch
 * scope in particular, a remounted Grove has no other way to see the finished reply until its own
 * persisted-messages query happens to refetch, so clearing here would make it flash and vanish.
 * The next `startConversation`/`startBranch` for that key fully replaces the entry anyway.
 */
export const useLiveTurnsStore = create<LiveTurnsState>((set, get) => ({
  turns: {},

  startConversation: (key) => set((s) => ({
    turns: { ...s.turns, [key]: { kind: 'conversation', renderState: emptyChatRenderState, status: 'streaming' } },
  })),

  applyFrame: (key, frame) => {
    const current = get().turns[key];
    const prevState = current?.kind === 'conversation' ? current.renderState : emptyChatRenderState;
    const nextState = reduceUnifiedFrames(prevState, frame as never);
    set((s) => ({
      turns: { ...s.turns, [key]: { kind: 'conversation', renderState: nextState, status: 'streaming' } },
    }));
    return nextState;
  },

  startBranch: (key) => set((s) => ({
    turns: { ...s.turns, [key]: { kind: 'branch', trailing: { role: 'assistant', content: '' }, status: 'streaming' } },
  })),

  appendBranchDelta: (key, delta) => {
    const current = get().turns[key];
    const prevTrailing: ChatMessageData = current?.kind === 'branch'
      ? current.trailing
      : { role: 'assistant', content: '' };
    const nextTrailing: ChatMessageData = {
      ...prevTrailing,
      content: prevTrailing.content + (delta.content ?? ''),
      reasoning: (prevTrailing.reasoning ?? '') + (delta.reasoning ?? ''),
      ...(delta.interruptedReason ? { interruptedReason: delta.interruptedReason } : {}),
    };
    set((s) => ({ turns: { ...s.turns, [key]: { kind: 'branch', trailing: nextTrailing, status: 'streaming' } } }));
    return nextTrailing;
  },

  finish: (key, status) => set((s) => {
    const current = s.turns[key];
    if (!current) return s;
    return { turns: { ...s.turns, [key]: { ...current, status } } };
  }),
}));

/**
 * Appends a branch's live/finished trailing message onto its persisted messages — used only when
 * nothing else is already tracking this branch's live edits locally (see `Grove.tsx`), i.e. the
 * component watching this branch was remounted mid-turn or after one finished.
 */
export function overlayBranchMessages(
  persisted: ChatMessageData[],
  turn: LiveTurn | undefined,
): ChatMessageData[] {
  if (!turn || turn.kind !== 'branch') return persisted;
  return [...persisted, turn.trailing];
}
