import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  openChatPackStream,
  listChatConversations,
  getChatConversation,
  createChatConversation,
  deleteChatConversation,
  chatPackKeys,
  type ChatConversation,
} from '../../../api/chat-pack.js';
import { emptyChatRenderState, type ChatRenderState } from '../../../lib/chat-unified-reducer.js';
import { useLiveTurnsStore, conversationTurnKey } from '../../../stores/live-turns.js';
import { errorMessage } from '../../../api/client.js';
import { readSseFrames, assistantMsgFromRenderState, type ChatMessageRecord } from '../chat-stream.js';

const EMPTY_MESSAGES: ChatMessageRecord[] = [];

export interface UseConversationTurnOptions {
  externalConvId?: string | undefined;
  externalSessionId?: string | undefined;
  modelId?: string | undefined;
  initialMessages?: ChatMessageRecord[] | undefined;
  enabled: boolean;
  onConversationChange?: ((id: string | null) => void) | undefined;
  onProposedTree?: (() => void) | undefined;
}

export function useConversationTurn({
  externalConvId,
  externalSessionId,
  modelId,
  initialMessages = EMPTY_MESSAGES,
  enabled,
  onConversationChange,
  onProposedTree,
}: UseConversationTurnOptions) {
  const qc = useQueryClient();
  const [selectedConvId, setSelectedConvId] = useState<string | null>(externalConvId ?? null);
  const [creatingConversation, setCreatingConversation] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [localMessagesByConv, setLocalMessagesByConv] = useState<Record<string, ChatMessageRecord[]>>({});
  const localMessages = (selectedConvId && localMessagesByConv[selectedConvId]) || EMPTY_MESSAGES;

  const appendLocalMessage = useCallback((convId: string, msg: ChatMessageRecord) => {
    setLocalMessagesByConv((prev) => ({ ...prev, [convId]: [...(prev[convId] ?? []), msg] }));
  }, []);

  const clearLocalMessages = useCallback((convId: string) => {
    setLocalMessagesByConv((prev) => {
      if (!(convId in prev)) return prev;
      const next = { ...prev };
      delete next[convId];
      return next;
    });
  }, []);

  const [unsavedModelPicks, setUnsavedModelPicks] = useState<Record<string, string | null>>({});
  const abortRef = useRef<AbortController | null>(null);
  const localSessionId = useRef(externalSessionId ?? Math.random().toString(36).slice(2));

  const liveTurnKey = enabled && selectedConvId ? conversationTurnKey(selectedConvId) : null;
  const currentTurn = useLiveTurnsStore((s) => (liveTurnKey ? s.turns[liveTurnKey] : undefined));
  const streaming = currentTurn?.status === 'streaming' || creatingConversation;
  const liveState: ChatRenderState = currentTurn?.renderState ?? emptyChatRenderState;
  const overthinkWarning = streaming ? currentTurn?.renderState.overthinkWarning : undefined;

  useEffect(() => {
    if (externalConvId !== undefined) {
      setSelectedConvId(externalConvId);
    }
  }, [externalConvId]);

  const { data: conversations = [] } = useQuery<ChatConversation[]>({
    queryKey: chatPackKeys.conversations(),
    queryFn: listChatConversations,
    enabled,
  });

  const { data: activeConversation, isFetching: loadingConversation } = useQuery<ChatConversation | null>({
    queryKey: chatPackKeys.conversation(selectedConvId ?? ''),
    queryFn: () => (selectedConvId ? getChatConversation(selectedConvId) : null),
    enabled: enabled && Boolean(selectedConvId),
    staleTime: 30_000,
  });

  const confirmedLenRef = useRef<Record<string, number>>({});
  useEffect(() => {
    const convId = activeConversation?.id;
    if (!convId) return;
    const persistedLen = activeConversation?.messages?.length ?? 0;
    setLocalMessagesByConv((prev) => {
      const local = prev[convId];
      if (!local || local.length === 0) {
        confirmedLenRef.current[convId] = persistedLen;
        return prev;
      }
      const baseline = confirmedLenRef.current[convId] ?? persistedLen;
      if (persistedLen < baseline + local.length) return prev;
      const next = { ...prev };
      delete next[convId];
      return next;
    });
  }, [activeConversation]);

  useEffect(() => {
    if (!enabled) return;
    if (!selectedConvId && conversations.length > 0 && !externalConvId) {
      const first = conversations[0];
      if (first) {
        setSelectedConvId(first.id);
        onConversationChange?.(first.id);
      }
    }
  }, [enabled, conversations, selectedConvId, externalConvId, onConversationChange]);

  const createMutation = useMutation({
    mutationFn: () => createChatConversation('New conversation'),
    onSuccess: (newConv) => {
      qc.invalidateQueries({ queryKey: chatPackKeys.conversations() });
      setSelectedConvId(newConv.id);
      setError(null);
      onConversationChange?.(newConv.id);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteChatConversation(id),
    onSuccess: (_, deletedId) => {
      qc.invalidateQueries({ queryKey: chatPackKeys.conversations() });
      clearLocalMessages(deletedId);
      if (selectedConvId === deletedId) {
        const remaining = conversations.filter((c) => c.id !== deletedId);
        const nextId = remaining[0]?.id ?? null;
        setSelectedConvId(nextId);
        onConversationChange?.(nextId);
      }
    },
  });

  const conversationKey = activeConversation?.id ?? 'unsent';
  const pinnedModelId = conversationKey in unsavedModelPicks
    ? unsavedModelPicks[conversationKey]!
    : (activeConversation?.modelId ?? modelId ?? null);
  const setPinnedModelId = (id: string | null) =>
    setUnsavedModelPicks((prev) => ({ ...prev, [conversationKey]: id }));

  const sendConversationTurn = async (text: string) => {
    let targetConvId = selectedConvId;
    if (!targetConvId) {
      setCreatingConversation(true);
      try {
        const created = await createChatConversation('New conversation');
        targetConvId = created.id;
        setSelectedConvId(created.id);
        onConversationChange?.(created.id);
        qc.invalidateQueries({ queryKey: chatPackKeys.conversations() });
      } catch (err) {
        setError(`Failed to create conversation: ${errorMessage(err)}`);
        setCreatingConversation(false);
        return;
      }
      setCreatingConversation(false);
    }

    const key = conversationTurnKey(targetConvId);
    const userMsg: ChatMessageRecord = {
      role: 'user',
      content: text,
      at: new Date().toISOString(),
    };
    appendLocalMessage(targetConvId, userMsg);
    useLiveTurnsStore.getState().start(key);

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const response = await openChatPackStream(
        {
          conversationId: targetConvId,
          message: text,
          sessionId: localSessionId.current,
          ...(pinnedModelId ? { modelId: pinnedModelId } : {}),
        },
        abort.signal,
      );

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(errText || `Server responded with ${response.status}`);
      }

      if (response.body) {
        await readSseFrames(response.body, (frame) => {
          useLiveTurnsStore.getState().applyFrame(key, frame);
          if (frame.type === 'proposedTree') onProposedTree?.();
        });
      }

      const finalTurn = useLiveTurnsStore.getState().turns[key];
      const finalState = finalTurn?.renderState ?? emptyChatRenderState;
      const assistantMsg = assistantMsgFromRenderState(finalState);
      if (assistantMsg) appendLocalMessage(targetConvId, assistantMsg);

      useLiveTurnsStore.getState().finish(key, 'done');

      qc.invalidateQueries({ queryKey: chatPackKeys.conversation(targetConvId) });
      qc.invalidateQueries({ queryKey: chatPackKeys.conversations() });
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        useLiveTurnsStore.getState().finish(key, 'done');
      } else {
        const turn = useLiveTurnsStore.getState().turns[key];
        const state = turn?.renderState ?? emptyChatRenderState;
        const msg = assistantMsgFromRenderState(state);
        if (msg) appendLocalMessage(targetConvId, { ...msg, interruptedReason: `Stopped early: ${errorMessage(err)}` });
        setError(`Turn failed: ${errorMessage(err)}`);
        useLiveTurnsStore.getState().finish(key, 'error');
      }
      qc.invalidateQueries({ queryKey: chatPackKeys.conversation(targetConvId) });
      qc.invalidateQueries({ queryKey: chatPackKeys.conversations() });
    } finally {
      abortRef.current = null;
    }
  };

  const handleStop = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      if (liveTurnKey && selectedConvId) {
        const turn = useLiveTurnsStore.getState().turns[liveTurnKey];
        const state = turn?.renderState ?? emptyChatRenderState;
        const msg = assistantMsgFromRenderState(state);
        if (msg) appendLocalMessage(selectedConvId, { ...msg, interruptedReason: 'Stopped' });
      }
      if (liveTurnKey) useLiveTurnsStore.getState().finish(liveTurnKey, 'done');
    }
  }, [liveTurnKey, selectedConvId, appendLocalMessage]);

  const renderedMessages = useMemo(() => {
    if (!enabled) return EMPTY_MESSAGES;
    if (initialMessages.length > 0 && (!activeConversation || (activeConversation.messages?.length ?? 0) === 0)) {
      return [...initialMessages, ...localMessages];
    }
    const persisted = activeConversation?.messages ?? initialMessages;
    return [...persisted, ...localMessages];
  }, [enabled, activeConversation, initialMessages, localMessages]);

  return {
    selectedConvId,
    setSelectedConvId,
    conversations,
    activeConversation,
    loadingConversation,
    localMessages,
    renderedMessages,
    streaming,
    liveState,
    overthinkWarning,
    error,
    setError,
    pinnedModelId,
    setPinnedModelId,
    createMutation,
    deleteMutation,
    sendConversationTurn,
    handleStop,
  };
}
