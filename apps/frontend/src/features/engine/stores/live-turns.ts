import { create } from 'zustand';
import { reduceUnifiedFrames, emptyChatRenderState, type ChatRenderState } from '../lib/chat-unified-reducer.js';

export type TurnStatus = 'streaming' | 'done' | 'error';

export interface LiveTurn {
  renderState: ChatRenderState;
  status: TurnStatus;
}

export const conversationTurnKey = (conversationId: string): string => `conversation:${conversationId}`;
export const branchTurnKey = (branchId: string): string => `branch:${branchId}`;

interface LiveTurnsState {
  turns: Record<string, LiveTurn>;
  start: (key: string) => void;
  applyFrame: (key: string, frame: unknown) => ChatRenderState;
  finish: (key: string, status: 'done' | 'error') => void;
}

/**
 * Ephemeral SSE-stream accumulation, keyed by conversation/branch id, decoupled from any
 * component's lifecycle — a view swap in App.tsx fully unmounts the chat subtree, but the
 * `readSseFrames` loop that's already reading the stream keeps running as an orphaned promise
 * regardless. Writing into this store instead of component state means that loop's progress
 * survives the unmount, and whichever component remounts for that id picks up where it left off.
 *
 * A turn is left in place (status 'done'/'error') rather than removed on completion — a remounted
 * view has no other way to see the finished reply until its own persisted-messages query happens
 * to refetch, so clearing here would make it flash and vanish. The next `start` for that key fully
 * replaces the entry anyway.
 */
export const useLiveTurnsStore = create<LiveTurnsState>((set, get) => ({
  turns: {},

  start: (key) => set((s) => ({
    turns: { ...s.turns, [key]: { renderState: emptyChatRenderState, status: 'streaming' } },
  })),

  applyFrame: (key, frame) => {
    const current = get().turns[key];
    const prevState = current?.renderState ?? emptyChatRenderState;
    const nextState = reduceUnifiedFrames(prevState, frame as never);
    set((s) => ({
      turns: { ...s.turns, [key]: { renderState: nextState, status: 'streaming' } },
    }));
    return nextState;
  },

  finish: (key, status) => set((s) => {
    const current = s.turns[key];
    if (!current) return s;
    return { turns: { ...s.turns, [key]: { ...current, status } } };
  }),
}));
