import { useRef, useCallback, useEffect } from 'react';
import { openChatStream } from '../../../api/chat.js';
import { getProjectFileContent } from '../../../api/project-files.js';
import { useLiveTurnsStore, branchTurnKey } from '../../../stores/live-turns.js';
import { errorMessage } from '../../../api/client.js';
import { emptyChatRenderState } from '../../../lib/chat-unified-reducer.js';
import { readSseFrames, assistantMsgFromRenderState, type ChatMessageRecord } from '../chat-stream.js';

export type ChatMode = 'chat' | 'auto' | 'plan';

export interface ProposedLeaf {
  id: string;
  title: string;
  body?: string;
  packId?: string;
}

export interface ChatAttachment {
  path: string;
  type: 'file' | 'dir';
}

export interface ChatScope {
  kind: 'branch';
  branchId: string;
  treeId?: string | undefined;
  mode: ChatMode;
  onModeChange?: ((mode: ChatMode) => void) | undefined;
  messages: ChatMessageRecord[];
  onMessagesChange: (next: ChatMessageRecord[] | ((prev: ChatMessageRecord[]) => ChatMessageRecord[])) => void;
  onProposals?: (() => void) | undefined;
  proposed?: ProposedLeaf[] | undefined;
  onAccept?: ((id: string) => void) | undefined;
  onReject?: ((id: string) => void) | undefined;
  onAcceptAll?: (() => void) | undefined;
  autoSend?: string | undefined;
  onAutoSent?: (() => void) | undefined;
  projectId?: string | undefined;
  attachments?: ChatAttachment[] | undefined;
  onRemoveAttachment?: ((path: string) => void) | undefined;
}

export interface UseBranchTurnOptions {
  branch?: ChatScope | undefined;
  branchModelId: string | null;
  onError: (msg: string | null) => void;
}

export function useBranchTurn({ branch, branchModelId, onError }: UseBranchTurnOptions) {
  const abortRef = useRef<AbortController | null>(null);

  const liveTurnKey = branch?.branchId ? branchTurnKey(branch.branchId) : null;
  const currentTurn = useLiveTurnsStore((s) => (liveTurnKey ? s.turns[liveTurnKey] : undefined));
  const streaming = currentTurn?.status === 'streaming';
  const liveState = currentTurn?.renderState ?? emptyChatRenderState;
  const overthinkWarning = streaming ? currentTurn?.renderState.overthinkWarning : undefined;

  /** Resolves attached files/folders into a `<context>` block prepended ahead of the typed message. */
  const buildAttachmentsPrefix = async (): Promise<string> => {
    const attachments = branch?.attachments ?? [];
    if (attachments.length === 0) return '';
    const blocks = await Promise.all(attachments.map(async (a) => {
      if (a.type === 'dir') return `<context folder="${a.path}"/>`;
      if (!branch?.projectId) return `<context file="${a.path}">(no project to read this from)</context>`;
      try {
        const { content } = await getProjectFileContent(branch.projectId, a.path);
        return `<context file="${a.path}">\n${content}\n</context>`;
      } catch (err) {
        return `<context file="${a.path}">(could not load this file: ${errorMessage(err)})</context>`;
      }
    }));
    return `${blocks.join('\n')}\n\n`;
  };

  const sendBranchTurn = async (text: string, activeMode: ChatMode) => {
    if (!branch) return;
    const key = branchTurnKey(branch.branchId);
    const outbound = [...branch.messages, { role: 'user' as const, content: text }];
    branch.onMessagesChange(outbound);
    onError(null);
    useLiveTurnsStore.getState().start(key);

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const res = await openChatStream({
        messages: outbound,
        stream: true,
        branchId: branch.branchId,
        mode: activeMode,
        ...(branchModelId ? { modelId: branchModelId } : {}),
      }, abort.signal);

      if (!res.body) throw new Error('No response body');

      await readSseFrames(res.body, (frame) => {
        useLiveTurnsStore.getState().applyFrame(key, frame);
      });

      const finalTurn = useLiveTurnsStore.getState().turns[key];
      const finalState = finalTurn?.renderState ?? emptyChatRenderState;
      const assistantMsg = assistantMsgFromRenderState(finalState);
      if (assistantMsg) branch.onMessagesChange((prev) => [...prev, assistantMsg]);

      useLiveTurnsStore.getState().finish(key, 'done');
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        useLiveTurnsStore.getState().finish(key, 'done');
      } else {
        const turn = useLiveTurnsStore.getState().turns[key];
        const state = turn?.renderState ?? emptyChatRenderState;
        const msg = assistantMsgFromRenderState(state);
        if (msg) branch.onMessagesChange((prev) => [...prev, { ...msg, interruptedReason: `Stopped early: ${err.message}` }]);
        onError(err.message);
        useLiveTurnsStore.getState().finish(key, 'error');
      }
    } finally {
      abortRef.current = null;
      if (activeMode !== 'chat') branch.onProposals?.();
    }
  };

  const handleBranchSend = (rawText: string) => {
    if (!branch) return;
    const text = rawText.trim();
    if (!text || streaming) return;

    const command = /^\/(chat|auto|plan)\b\s*([\s\S]*)$/i.exec(text);
    if (command) {
      const next = command[1]!.toLowerCase() as ChatMode;
      const rest = (command[2] ?? '').trim();
      branch.onModeChange?.(next);
      if (!rest) return;
      const body = next === 'plan' ? `/plan ${rest}` : rest;
      void buildAttachmentsPrefix().then((prefix) => sendBranchTurn(prefix + body, next));
      return;
    }
    void buildAttachmentsPrefix().then((prefix) => sendBranchTurn(prefix + text, branch.mode));
  };

  const handleBranchStop = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      if (liveTurnKey) {
        const turn = useLiveTurnsStore.getState().turns[liveTurnKey];
        const state = turn?.renderState ?? emptyChatRenderState;
        const msg = assistantMsgFromRenderState(state);
        if (msg && branch) branch.onMessagesChange((prev) => [...prev, { ...msg, interruptedReason: 'Stopped' }]);
        useLiveTurnsStore.getState().finish(liveTurnKey, 'done');
      }
    }
  }, [liveTurnKey, branch]);

  const branchAutoSentRef = useRef<string | null>(null);
  useEffect(() => {
    if (!branch?.autoSend || branchAutoSentRef.current === branch.autoSend || streaming) return;
    branchAutoSentRef.current = branch.autoSend;
    branch.onAutoSent?.();
    void sendBranchTurn(branch.autoSend, branch.mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branch?.autoSend]);

  return {
    streaming,
    liveState,
    overthinkWarning,
    sendBranchTurn,
    handleBranchSend,
    handleBranchStop,
  };
}
