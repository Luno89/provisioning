import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listChatConversations,
  getChatConversation,
  createChatConversation,
  deleteChatConversation,
  patchChatConversation,
  chatPackKeys,
  type ChatConversation,
  type ConversationBinding,
} from '../../../api/chat-pack.js';
import {
  startRun,
  cancelRun,
  approveRunCall,
  type EngineEvent,
  type StartedRun,
} from '../../../api/engine.js';
import { readTurn, TURN_LOG_CHANNEL } from '../../../api/turns';
import { createTurnFollower } from '../../../lib/turn-follower';
import type { TurnLogEntry } from '../../../types/turns';
import { emptyChatRenderState, type ChatRenderState } from '../../../lib/chat-unified-reducer.js';
import { useLiveTurnsStore, conversationTurnKey } from '../../../stores/live-turns.js';
import { useSocketEvent } from '../../../stores/socket.js';
import { errorMessage } from '../../../api/client.js';
import { childEventToFrame, engineEventToFrame } from '../engine-event-frames.js';
import { planKeys } from '../../../api/plans';
import { assistantMsgFromRenderState, type ChatMessageRecord } from '../chat-stream.js';

const EMPTY_MESSAGES: ChatMessageRecord[] = [];

/**
 * The koala chat surface now drives an engine run per turn: POST /engine/runs starts it, the
 * run's events arrive on ENGINE_EVENT_CHANNEL, and engine-event-frames.ts translates them into
 * the UnifiedFrames this render state already understands.
 */
/** The agent slug every koala-chat turn runs on by default — the seed persona. */
const DEFAULT_CHAT_AGENT = 'koala';

/**
 * In-flight runs, by runId, at module scope. This is what a turn "is": a conversation key plus
 * a live-turn key, and it must survive the surface being navigated away from mid-turn (the old
 * code had the same shape as an orphaned SSE read feeding the module-level store). A remounted
 * surface re-attaches to it and keeps receiving frames.
 */
/** Every run drawing into a live turn: the turn's own run (an empty path) and each hand-off's run, by the chain of calls that led to it. */
const liveRunsByRunId = new Map<string, { convId: string; key: string; path: string[] }>();

const PROPOSING = new Set(['propose_plan', 'propose_leaf_plan']);

/** Every live turn's log, followed in order: the one source a turn is drawn from, live or after a refresh. */
const follower = createTurnFollower(readTurn);

/** Turns this tab has seen end, so a conversation still cached as mid-turn does not start drawing one again. */
const endedTurns = new Set<string>();

const forgetTurn = (key: string): void => {
  for (const [runId, entry] of liveRunsByRunId) if (entry.key === key) liveRunsByRunId.delete(runId);
};

export interface PendingApproval {
  runId: string;
  /** The engine's warn notice explaining what is being asked. */
  reason: string;
  /** Set when the request arrived on the heels of the tool call it needs. */
  callId?: string | undefined;
  toolName?: string | undefined;
  args?: string | undefined;
}

export interface UseConversationTurnOptions {
  externalConvId?: string | undefined;
  externalSessionId?: string | undefined;
  modelId?: string | undefined;
  initialMessages?: ChatMessageRecord[] | undefined;
  enabled: boolean;
  onConversationChange?: ((id: string | null) => void) | undefined;
  binding?: ConversationBinding | undefined;
}

export function useConversationTurn({
  externalConvId,
  modelId,
  initialMessages = EMPTY_MESSAGES,
  enabled,
  onConversationChange,
  binding,
}: UseConversationTurnOptions) {
  const qc = useQueryClient();
  const [pickedConvId, setSelectedConvId] = useState<string | null>(externalConvId ?? null);
  const [seenExternalConvId, setSeenExternalConvId] = useState(externalConvId);
  if (externalConvId !== seenExternalConvId) {
    setSeenExternalConvId(externalConvId);
    if (externalConvId !== undefined) setSelectedConvId(externalConvId);
  }

  const { data: conversations = [] } = useQuery<ChatConversation[]>({
    queryKey: chatPackKeys.conversations(),
    queryFn: listChatConversations,
    enabled,
  });

  const autoConvId = enabled && !pickedConvId && !externalConvId ? conversations[0]?.id ?? null : null;
  const selectedConvId = pickedConvId ?? autoConvId;
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
  // Same, per conversation, for the running agent. Absent (document) or null (picker) means the
  // default agent — 'koala'.
  const [unsavedAgentPicks, setUnsavedAgentPicks] = useState<Record<string, string | null>>({});

  // --- the in-flight engine run, and the approvals it asks for ----------------
  /** The run this instance started, so the steering buttons act on it. */
  const activeRunRef = useRef<{ runId: string; convId: string; key: string } | null>(null);
  /** Keys already settled, so a settle racing another settle (optimistic stop vs. the
   *  run.finished on its tail) cannot append the partial message twice. */
  const settledKeysRef = useRef<Set<string>>(new Set());
  /** Tool calls announced but not yet resulted — the pending-call one becomes the approval. */
  const pendingCallsRef = useRef<Map<string, { name: string; args: string }>>(new Map());
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);

  const liveTurnKey = enabled && selectedConvId ? conversationTurnKey(selectedConvId) : null;
  const currentTurn = useLiveTurnsStore((s) => (liveTurnKey ? s.turns[liveTurnKey] : undefined));
  const streaming = currentTurn?.status === 'streaming' || creatingConversation;
  const liveState: ChatRenderState = currentTurn?.renderState ?? emptyChatRenderState;

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
    if (autoConvId) onConversationChange?.(autoConvId);
  }, [autoConvId, onConversationChange]);

  const createMutation = useMutation({
    mutationFn: () => createChatConversation('New conversation', binding),
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
  const selectedAgentSlug = conversationKey in unsavedAgentPicks
    ? (unsavedAgentPicks[conversationKey] ?? DEFAULT_CHAT_AGENT)
    : (activeConversation?.agentSlug ?? DEFAULT_CHAT_AGENT);
  const setSelectedAgentSlug = (slug: string | null) =>
    setUnsavedAgentPicks((prev) => ({ ...prev, [conversationKey]: slug }));

  // Persist the picks when they diverge from what the conversation doc already holds — a pick
  // made after the doc loaded, or the first message (picks linger under the 'unsent' key until
  // the conversation exists, then get patched). Only fires on divergence, so a refetch that
  // picks up the patched doc settles without re-patching.
  const { mutate: persistSelection, isPending: persistingSelection } = useMutation({
    mutationFn: (picks: { convId: string; modelId: string | null; agentSlug: string | null }) =>
      patchChatConversation(picks.convId, { modelId: picks.modelId, agentSlug: picks.agentSlug }),
    onSuccess: (_doc, picks) => {
      qc.setQueryData<ChatConversation | null>(chatPackKeys.conversation(picks.convId), (prev) =>
        (prev ? { ...prev, modelId: picks.modelId, agentSlug: picks.agentSlug } : prev));
    },
  });
  useEffect(() => {
    const conv = activeConversation;
    if (!conv || persistingSelection) return;
    const docModel = conv.modelId ?? null;
    const localModel = pinnedModelId ?? null;
    const docAgent = conv.agentSlug ?? null;
    const localAgent = selectedAgentSlug ?? null;
    if (docModel === localModel && docAgent === localAgent) return;
    persistSelection({ convId: conv.id, modelId: localModel, agentSlug: localAgent });
  }, [pinnedModelId, selectedAgentSlug, activeConversation, persistingSelection, persistSelection]);

  // --- settling a turn -------------------------------------------------------
  const settleTurn = useCallback(
    (convId: string, key: string, outcome: string, reason?: string, stoppedByUser = false) => {
      if (settledKeysRef.current.has(key)) return;
      settledKeysRef.current.add(key);

      const turn = useLiveTurnsStore.getState().turns[key];
      const state = turn?.renderState ?? emptyChatRenderState;
      const msg = assistantMsgFromRenderState(state);
      if (msg) {
        let note: string | undefined;
        if (stoppedByUser) note = 'Stopped';
        else if (outcome === 'interrupted') note = reason ?? 'The run stopped early';
        else if (outcome === 'failed') note = `Stopped early: ${reason ?? outcome}`;
        appendLocalMessage(convId, note ? { ...msg, interruptedReason: note } : msg);
      }

      useLiveTurnsStore.getState().finish(key, outcome === 'ok' || outcome === 'interrupted' ? 'done' : 'error');
      if (outcome === 'ok' || outcome === 'interrupted') setError(null);
      else setError(`Turn stopped: ${reason ?? outcome}`);

      qc.invalidateQueries({ queryKey: chatPackKeys.conversation(convId) });
      qc.invalidateQueries({ queryKey: chatPackKeys.conversations() });
      setPendingApproval(null);
    },
    [qc, appendLocalMessage],
  );

  // --- the turn's log ----------------------------------------------------------
  const applyEvent = (event: EngineEvent) => {
    const active = liveRunsByRunId.get(event.runId);
    if (!active) {
      const parent = event.type === 'run.started' && event.parentRunId ? liveRunsByRunId.get(event.parentRunId) : undefined;
      if (event.type !== 'run.started' || !parent || !event.parentCallId) return;
      const path = [...parent.path, event.parentCallId];
      liveRunsByRunId.set(event.runId, { convId: parent.convId, key: parent.key, path });
      useLiveTurnsStore.getState().applyFrame(parent.key, { type: 'childStarted', payload: { path, runId: event.runId, agentId: event.agentId } });
      return;
    }

    if (event.type === 'tool.called') pendingCallsRef.current.set(event.callId, { name: event.name, args: event.args });
    if (event.type === 'tool.result') {
      if (PROPOSING.has(pendingCallsRef.current.get(event.callId)?.name ?? '')) void qc.invalidateQueries({ queryKey: planKeys.all });
      pendingCallsRef.current.delete(event.callId);
    }
    if (event.type === 'notice' && event.level === 'warn') {
      const pending = pendingCallsRef.current.entries().next();
      const call = pending.done ? undefined : pending.value;
      setPendingApproval({
        runId: event.runId,
        reason: event.message,
        ...(call ? { callId: call[0], toolName: call[1].name, args: call[1].args } : {}),
      });
    }

    if (active.path.length > 0) {
      const mapped = childEventToFrame(event, active.path);
      if (mapped.kind === 'frame') useLiveTurnsStore.getState().applyFrame(active.key, mapped.frame);
      if (event.type === 'run.finished' || event.type === 'interrupted') liveRunsByRunId.delete(event.runId);
      return;
    }

    const mapped = engineEventToFrame(event);
    if (mapped.kind === 'frame') {
      useLiveTurnsStore.getState().applyFrame(active.key, mapped.frame);
    } else if (mapped.kind === 'ended') {
      forgetTurn(active.key);
      follower.forget(event.runId);
      endedTurns.add(event.runId);
      if (activeRunRef.current?.runId === event.runId) activeRunRef.current = null;
      settleTurn(active.convId, active.key, mapped.outcome, mapped.reason);
    }
  };

  const applyRef = useRef<(event: EngineEvent) => void>(() => undefined);
  useEffect(() => { applyRef.current = applyEvent; });
  const apply = useCallback((entry: TurnLogEntry) => { for (const event of entry.events) applyRef.current(event); }, []);

  useSocketEvent<TurnLogEntry>(TURN_LOG_CHANNEL, (entry) => follower.receive(entry, apply));

  useEffect(() => {
    for (const turnId of follower.followed()) void follower.catchUp(turnId, apply).catch(() => undefined);
  }, [apply]);

  /** A conversation that loads mid-turn — after a refresh, from another tab — draws the turn from its log. */
  const liveTurnOf = activeConversation?.liveTurn?.runId;
  useEffect(() => {
    const convId = activeConversation?.id;
    if (!enabled || !convId || !liveTurnOf || follower.following(liveTurnOf) || endedTurns.has(liveTurnOf)) return;
    const key = conversationTurnKey(convId);
    useLiveTurnsStore.getState().start(key);
    settledKeysRef.current.delete(key);
    pendingCallsRef.current = new Map();
    liveRunsByRunId.set(liveTurnOf, { convId, key, path: [] });
    activeRunRef.current = { runId: liveTurnOf, convId, key };
    void follower.follow(liveTurnOf, apply).catch((err) => setError(`Could not catch up on the turn: ${errorMessage(err)}`));
  }, [enabled, activeConversation?.id, liveTurnOf, apply]);

  // --- sending a turn ----------------------------------------------------------
  const sendConversationTurn = async (text: string) => {
    let targetConvId = selectedConvId;
    if (!targetConvId) {
      setCreatingConversation(true);
      try {
        const created = await createChatConversation('New conversation', binding);
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
    settledKeysRef.current.delete(key);
    pendingCallsRef.current = new Map();

    let started: StartedRun;
    try {
      started = await startRun({
        agent: selectedAgentSlug,
        message: text,
        inputs: { conversationId: targetConvId },
        conversationId: targetConvId,
        ...(pinnedModelId ? { modelId: pinnedModelId } : {}),
      });
    } catch (err) {
      const state = useLiveTurnsStore.getState().turns[key]?.renderState ?? emptyChatRenderState;
      const msg = assistantMsgFromRenderState(state);
      if (msg) appendLocalMessage(targetConvId, { ...msg, interruptedReason: `Stopped early: ${errorMessage(err)}` });
      setError(`Turn failed: ${errorMessage(err)}`);
      useLiveTurnsStore.getState().finish(key, 'error');
      qc.invalidateQueries({ queryKey: chatPackKeys.conversation(targetConvId) });
      return;
    }

    activeRunRef.current = { runId: started.runId, convId: targetConvId, key };
    liveRunsByRunId.set(started.runId, { convId: targetConvId, key, path: [] });
    void follower.follow(started.runId, apply).catch((err) => setError(`Could not follow the turn: ${errorMessage(err)}`));
  };

  const handleStop = useCallback(() => {
    const active = activeRunRef.current;
    if (!active) return;
    activeRunRef.current = null;
    forgetTurn(active.key);
    follower.forget(active.runId);
    endedTurns.add(active.runId);
    // The run's own interrupted/run.finished events follow, but the turn is settled now so the
    // bubble stops immediately instead of waiting on the round-trip.
    settleTurn(active.convId, active.key, 'interrupted', undefined, true);
    cancelRun(active.runId).catch(() => {
      /* the run may already be finished; nothing else to do */
    });
  }, [settleTurn]);

  const decideApproval = useCallback(
    async (allowed: boolean) => {
      const approval = pendingApproval;
      if (!approval) return;
      if (!approval.callId) return;
      setPendingApproval(null);
      try {
        await approveRunCall(approval.runId, { callId: approval.callId, allowed });
      } catch {
        setError('Approval could not be sent: the run may already have finished');
      }
    },
    [pendingApproval],
  );

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
    error,
    setError,
    pinnedModelId,
    setPinnedModelId,
    selectedAgentSlug,
    setSelectedAgentSlug,
    createMutation,
    deleteMutation,
    sendConversationTurn,
    handleStop,
    pendingApproval,
    decideApproval,
  };
}