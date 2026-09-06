
import { useState, useCallback, useEffect, useLayoutEffect, useRef, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus, History, ChevronDown, ArrowDown, AlertTriangle, X, ShieldAlert,
  Check, Sprout, Sparkles, Inbox, Square,
} from 'lucide-react';
import {
  openChatPackStream,
  listChatConversations,
  getChatConversation,
  createChatConversation,
  deleteChatConversation,
  acceptTreeProposal,
  dismissTreeProposal,
  acceptSpecProposal,
  dismissSpecProposal,
  acceptEscalationProposal,
  denyEscalationProposal,
  submitSecretRequest,
  dismissSecretRequest,
  chatPackKeys,
  type ChatConversation,
} from '../api/chat-pack.js';
import { openChatStream } from '../api/chat.js';
import { emptyChatRenderState, type ChatRenderState } from '../lib/chat-unified-reducer.js';
import { useLiveTurnsStore, conversationTurnKey, branchTurnKey } from '../stores/live-turns.js';
import { KoalaSpot } from './Koala.js';
import CollapsibleHistoryList from './CollapsibleHistoryList.js';
import ProposalsSidebar, { pendingProposalsCount } from './ProposalsSidebar.js';
import PersonaConfigDrawer from './PersonaConfigDrawer.js';
import ModelConfigDrawer from './ModelConfigDrawer.js';
import KoalaLoading from './KoalaLoading.js';
import ChatHero from './Chat/ChatHero.js';
import ChatComposer, { type PersonaPackOption } from './Chat/ChatComposer.js';
import ChatMessageRow, { type ChatMessageData } from './Chat/ChatMessageRow.js';
import { errorMessage } from '../api/client.js';
import { listPacks, packKeys, type PersonaPack } from '../api/packs';
import { listTrees, listTreeTypes, groveKeys } from '../api/grove';
import { listModels, providerKeys, useDefaultModel, type ModelProvider } from '../api/models';
import { modelOptionLabel } from '../lib/model-label';
import { useShellStore } from '../stores/shell.js';

export interface ChatMessageRecord extends ChatMessageData {
  handoff?: boolean | undefined;
}

export type ChatMode = 'chat' | 'auto' | 'plan';

const MODE_HINT: Record<ChatMode, string> = {
  chat: 'just talking — nothing is created',
  auto: 'work is extracted from every reply',
  plan: 'actively breaking the work down',
};

export interface ProposedLeaf {
  id: string;
  title: string;
  body?: string;
  packId?: string;
}

/**
 * A branch (Grove) turn is a different shape of turn than a koala conversation: the message
 * array is a controlled prop the caller owns (client-authoritative, per `chat.ts`'s design — see
 * the plan's Part 7 note), not something this component fetches or persists locally. Everything
 * below this point is opt-in; omitting `scope` runs the koala/conversation path exactly as before.
 */
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
}

export interface ChatSurfaceProps {
  conversationId?: string | undefined;
  sessionId?: string | undefined;
  modelId?: string | undefined;
  initialMessages?: ChatMessageRecord[] | undefined;
  hideSidebar?: boolean | undefined;
  onConversationChange?: ((conversationId: string | null) => void) | undefined;
  onOpenTree?: ((treeId: string) => void) | undefined;
  scope?: ChatScope | undefined;
}

/** One `data:` SSE frame at a time, shared by both scopes — they emit the exact same UnifiedFrame wire format. */
async function readSseFrames(body: ReadableStream<Uint8Array>, onFrame: (frame: any) => void): Promise<void> {
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

export default function ChatSurface({
  conversationId: externalConvId,
  sessionId: externalSessionId,
  modelId,
  initialMessages = [],
  hideSidebar = false,
  onConversationChange,
  onOpenTree,
  scope,
}: ChatSurfaceProps) {
  const qc = useQueryClient();
  const setShellView = useShellStore((s) => s.setView);
  const isBranch = scope?.kind === 'branch';
  const branch = isBranch ? scope : undefined;

  const [selectedConvId, setSelectedConvId] = useState<string | null>(externalConvId ?? null);
  const [input, setInput] = useState('');
  const [creatingConversation, setCreatingConversation] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localMessages, setLocalMessages] = useState<ChatMessageRecord[]>([]);

  const [showHistory, setShowHistory] = useState<boolean>(false);
  const [showProposals, setShowProposals] = useState<boolean>(false);
  const [showDropdown, setShowDropdown] = useState<boolean>(false);
  const [showPersonaDrawer, setShowPersonaDrawer] = useState<boolean>(false);
  const [showModelDrawer, setShowModelDrawer] = useState<boolean>(false);
  /**
   * Picks not yet sent, keyed by conversation. The stored pin lives on the conversation itself, so
   * this only holds a choice made since it loaded — derived rather than synced by an effect, which
   * is what keeps switching threads from briefly showing the previous one's engine.
   */
  const [unsavedModelPicks, setUnsavedModelPicks] = useState<Record<string, string | null>>({});
  const [branchModelId, setBranchModelId] = useState<string | null>(null);
  const [isAtBottom, setIsAtBottom] = useState<boolean>(true);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bottomAnchorRef = useRef<HTMLDivElement | null>(null);
  const localSessionId = useRef(externalSessionId ?? Math.random().toString(36).slice(2));

  const liveTurnKey = isBranch
    ? (branch?.branchId ? branchTurnKey(branch.branchId) : null)
    : (selectedConvId ? conversationTurnKey(selectedConvId) : null);
  const currentTurn = useLiveTurnsStore((s) => (liveTurnKey ? s.turns[liveTurnKey] : undefined));
  const streaming = currentTurn?.status === 'streaming' || creatingConversation;
  const liveState: ChatRenderState = currentTurn?.kind === 'conversation' ? currentTurn.renderState : emptyChatRenderState;
  const overthinkWarning = streaming
    ? (currentTurn?.kind === 'conversation' ? currentTurn.renderState.overthinkWarning : currentTurn?.kind === 'branch' ? currentTurn.overthinkWarning : undefined)
    : undefined;

  useEffect(() => {
    if (externalConvId !== undefined) {
      setSelectedConvId(externalConvId);
      setLocalMessages([]);
    }
  }, [externalConvId]);

  const { data: packs = [] } = useQuery<PersonaPack[]>({
    queryKey: packKeys.list(),
    queryFn: listPacks,
  });

  // Branch scope: who's actually answering is the tree type's planner-role pack (no
  // independently-picked pack any more — see the persona-pack plan). Resolved read-only here so
  // the composer can say who it is; changing it lives in Lab > Tree Types, not in the chat itself.
  const { data: trees = [] } = useQuery({
    queryKey: groveKeys.trees(),
    queryFn: listTrees,
    enabled: isBranch,
  });
  const { data: treeTypes = [] } = useQuery({
    queryKey: groveKeys.treeTypes(),
    queryFn: listTreeTypes,
    enabled: isBranch,
  });
  const branchTree = isBranch ? trees.find((t) => t.id === (branch?.treeId)) : undefined;
  const branchTreeType = branchTree ? treeTypes.find((t: any) => t.id === branchTree.type) : undefined;
  const plannerPackId = (branchTreeType as any)?.packs?.planner as string | undefined;
  const plannerPack = plannerPackId ? packs.find((p) => p.id === plannerPackId || p.slug === plannerPackId) : undefined;

  const { data: conversations = [] } = useQuery<ChatConversation[]>({
    queryKey: chatPackKeys.conversations(),
    queryFn: listChatConversations,
    enabled: !isBranch,
  });

  const { data: activeConversation, isFetching: loadingConversation } = useQuery<ChatConversation | null>({
    queryKey: chatPackKeys.conversation(selectedConvId ?? ''),
    queryFn: () => (selectedConvId ? getChatConversation(selectedConvId) : null),
    enabled: !isBranch && Boolean(selectedConvId),
    staleTime: 30_000,
  });

  const confirmedLenRef = useRef(0);
  useEffect(() => {
    const persistedLen = activeConversation?.messages?.length ?? 0;
    setLocalMessages((prev) => {
      if (prev.length === 0) {
        confirmedLenRef.current = persistedLen;
        return prev;
      }
      return persistedLen >= confirmedLenRef.current + prev.length ? [] : prev;
    });
  }, [activeConversation]);

  useEffect(() => {
    if (isBranch) return;
    if (!selectedConvId && conversations.length > 0 && !externalConvId) {
      const first = conversations[0];
      if (first) {
        setSelectedConvId(first.id);
        onConversationChange?.(first.id);
      }
    }
  }, [isBranch, conversations, selectedConvId, externalConvId, onConversationChange]);

  const createMutation = useMutation({
    mutationFn: () => createChatConversation('New conversation'),
    onSuccess: (newConv) => {
      qc.invalidateQueries({ queryKey: chatPackKeys.conversations() });
      setSelectedConvId(newConv.id);
      setLocalMessages([]);
      setError(null);
      onConversationChange?.(newConv.id);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteChatConversation(id),
    onSuccess: (_, deletedId) => {
      qc.invalidateQueries({ queryKey: chatPackKeys.conversations() });
      if (selectedConvId === deletedId) {
        const remaining = conversations.filter((c) => c.id !== deletedId);
        const nextId = remaining[0]?.id ?? null;
        setSelectedConvId(nextId);
        onConversationChange?.(nextId);
      }
    },
  });

  const acceptTreeMutation = useMutation({
    mutationFn: ({ convId, proposalId }: { convId: string; proposalId: string }) =>
      acceptTreeProposal(convId, proposalId),
    onSuccess: (res: any, variables) => {
      qc.invalidateQueries({ queryKey: chatPackKeys.conversation(variables.convId) });
      qc.invalidateQueries({ queryKey: chatPackKeys.conversations() });
      qc.invalidateQueries({ queryKey: ['trees'] });
      if (res?.treeId) {
        onOpenTree?.(res.treeId);
      }
    },
    onError: (err) => setError(`Could not accept the proposal: ${errorMessage(err)}`),
  });

  const acceptSpecMutation = useMutation({
    mutationFn: ({ convId, proposalId }: { convId: string; proposalId: string }) =>
      acceptSpecProposal(convId, proposalId),
    onSuccess: (_, variables) => {
      qc.invalidateQueries({ queryKey: chatPackKeys.conversation(variables.convId) });
      qc.invalidateQueries({ queryKey: chatPackKeys.conversations() });
    },
    onError: (err) => setError(`Could not add to the catalogue: ${errorMessage(err)}`),
  });

  const dismissTreeMutation = useMutation({
    mutationFn: ({ convId, proposalId }: { convId: string; proposalId: string }) =>
      dismissTreeProposal(convId, proposalId),
    onSuccess: (_, variables) => {
      qc.invalidateQueries({ queryKey: chatPackKeys.conversation(variables.convId) });
      qc.invalidateQueries({ queryKey: chatPackKeys.conversations() });
    },
    onError: (err) => setError(`Could not dismiss the proposal: ${errorMessage(err)}`),
  });

  const dismissSpecMutation = useMutation({
    mutationFn: ({ convId, proposalId }: { convId: string; proposalId: string }) =>
      dismissSpecProposal(convId, proposalId),
    onSuccess: (_, variables) => {
      qc.invalidateQueries({ queryKey: chatPackKeys.conversation(variables.convId) });
      qc.invalidateQueries({ queryKey: chatPackKeys.conversations() });
    },
    onError: (err) => setError(`Could not dismiss the proposal: ${errorMessage(err)}`),
  });

  const acceptEscalationMutation = useMutation({
    mutationFn: ({ convId, proposalId }: { convId: string; proposalId: string }) =>
      acceptEscalationProposal(convId, proposalId),
    onSuccess: (_, variables) => {
      qc.invalidateQueries({ queryKey: chatPackKeys.conversation(variables.convId) });
      qc.invalidateQueries({ queryKey: chatPackKeys.conversations() });
    },
    onError: (err) => setError(`Could not grant access: ${errorMessage(err)}`),
  });

  const denyEscalationMutation = useMutation({
    mutationFn: ({ convId, proposalId }: { convId: string; proposalId: string }) =>
      denyEscalationProposal(convId, proposalId),
    onSuccess: (_, variables) => {
      qc.invalidateQueries({ queryKey: chatPackKeys.conversation(variables.convId) });
      qc.invalidateQueries({ queryKey: chatPackKeys.conversations() });
    },
    onError: (err) => setError(`Could not deny access: ${errorMessage(err)}`),
  });

  const submitSecretMutation = useMutation({
    mutationFn: ({ convId, requestId, value }: { convId: string; requestId: string; value: string }) =>
      submitSecretRequest(convId, requestId, value),
    onSuccess: (_, variables) => {
      qc.invalidateQueries({ queryKey: chatPackKeys.conversation(variables.convId) });
      qc.invalidateQueries({ queryKey: chatPackKeys.conversations() });
    },
    onError: (err) => setError(`Could not save the secret: ${errorMessage(err)}`),
  });

  const dismissSecretMutation = useMutation({
    mutationFn: ({ convId, requestId }: { convId: string; requestId: string }) =>
      dismissSecretRequest(convId, requestId),
    onSuccess: (_, variables) => {
      qc.invalidateQueries({ queryKey: chatPackKeys.conversation(variables.convId) });
      qc.invalidateQueries({ queryKey: chatPackKeys.conversations() });
    },
    onError: (err) => setError(`Could not dismiss the secret request: ${errorMessage(err)}`),
  });

  const scrollToBottomInstant = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: 'smooth',
      });
      setIsAtBottom(true);
    }
  }, []);

  const handleFeedScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 60;
    setIsAtBottom(atBottom);
  }, []);

  useLayoutEffect(() => {
    if (isAtBottom) {
      scrollToBottomInstant();
    }
  }, [activeConversation?.messages, localMessages, branch?.messages, liveState.live, liveState.liveThinking, liveState.tools, streaming, isAtBottom, scrollToBottomInstant]);

  useEffect(() => {
    const feed = scrollRef.current;
    if (!feed || typeof ResizeObserver === 'undefined') return;

    const ro = new ResizeObserver(() => {
      if (isAtBottom && scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    });

    ro.observe(feed);
    return () => ro.disconnect();
  }, [isAtBottom]);

  const { data: defaultSetting } = useDefaultModel();
  const accountDefaultId = defaultSetting?.defaultModelId ?? null;

  /**
   * What this conversation runs on: a pick made since it loaded, else the engine it last ran on,
   * else what the surface was opened with — nothing meaning it follows the pack and the account
   * default. Derived rather than synced by an effect, so switching threads never briefly shows the
   * previous one's engine.
   */
  const conversationKey = activeConversation?.id ?? 'unsent';
  const pinnedModelId = conversationKey in unsavedModelPicks
    ? unsavedModelPicks[conversationKey]!
    : (activeConversation?.modelId ?? modelId ?? null);
  const setPinnedModelId = (id: string | null) =>
    setUnsavedModelPicks((prev) => ({ ...prev, [conversationKey]: id }));

  const activeModelId = isBranch ? branchModelId : pinnedModelId;
  const setActiveModelId = isBranch ? setBranchModelId : setPinnedModelId;

  /**
   * 425 endpoint rows is ~236KB, and registering a gateway is the only thing that changes it — so
   * refetching on every mount and window focus is pure cost on a screen that only needs the
   * selected model's name.
   */
  const { data: models = [] } = useQuery<ModelProvider[]>({
    queryKey: providerKeys.list(),
    queryFn: listModels,
    staleTime: 5 * 60_000,
  });

  /** Grove chats picked no model before; keep that — auto-pick the first once the list arrives. */
  useEffect(() => {
    if (isBranch && !branchModelId && models.length) setBranchModelId(models[0]!.id);
  }, [isBranch, models, branchModelId]);

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
    setLocalMessages((prev) => [...prev, userMsg]);
    useLiveTurnsStore.getState().startConversation(key);

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
        });
      }

      const finalTurn = useLiveTurnsStore.getState().turns[key];
      const finalState = finalTurn?.kind === 'conversation' ? finalTurn.renderState : emptyChatRenderState;
      if (finalState.live || finalState.liveThinking || finalState.tools.length > 0) {
        const assistantMsg: ChatMessageRecord = {
          role: 'assistant',
          content: finalState.live,
          at: new Date().toISOString(),
          ...(finalState.liveThinking ? { reasoning: finalState.liveThinking } : {}),
          ...(finalState.enabled.length > 0 ? { enabled: finalState.enabled } : {}),
          ...(finalState.tools.length > 0
            ? {
                toolCalls: finalState.tools.map((t) => ({
                  id: t.id,
                  name: t.name,
                  args: t.args ?? '',
                  ok: t.ok ?? true,
                  digest: t.digest ?? '',
                })),
              }
            : {}),
        };
        setLocalMessages((prev) => [...prev, assistantMsg]);
      }

      useLiveTurnsStore.getState().finish(key, 'done');

      qc.invalidateQueries({ queryKey: chatPackKeys.conversation(targetConvId) });
      qc.invalidateQueries({ queryKey: chatPackKeys.conversations() });
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        useLiveTurnsStore.getState().finish(key, 'done');
      } else {
        setError(`Turn failed: ${errorMessage(err)}`);
        useLiveTurnsStore.getState().finish(key, 'error');
      }
    } finally {
      abortRef.current = null;
    }
  };

  const sendBranchTurn = async (text: string, activeMode: ChatMode) => {
    if (!branch) return;
    const key = branchTurnKey(branch.branchId);
    const outbound = [...branch.messages, { role: 'user' as const, content: text }];
    branch.onMessagesChange([...outbound, { role: 'assistant', content: '' }]);
    setError(null);
    useLiveTurnsStore.getState().startBranch(key);

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
        const deltaContent = frame.type === 'content' ? String(frame.delta ?? '') : '';
        const deltaReasoning = frame.type === 'thinking' ? String(frame.delta ?? '') : '';
        const interruptedReason = frame.type === 'interrupted' ? String(frame.payload ?? '') : undefined;
        const overthinkWarning = frame.type === 'overthinkWarning' ? String(frame.payload ?? '') : undefined;
        if (!deltaContent && !deltaReasoning && !interruptedReason && !overthinkWarning) return;

        useLiveTurnsStore.getState().appendBranchDelta(key, {
          content: deltaContent, reasoning: deltaReasoning, interruptedReason, overthinkWarning,
        });

        branch.onMessagesChange((prev) => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          if (!last) return copy;
          copy[copy.length - 1] = {
            ...last,
            content: last.content + deltaContent,
            reasoning: (last.reasoning ?? '') + deltaReasoning,
            ...(interruptedReason ? { interruptedReason } : {}),
          };
          return copy;
        });
      });
      useLiveTurnsStore.getState().finish(key, 'done');
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        setError(err.message);
        useLiveTurnsStore.getState().finish(key, 'error');
      } else {
        useLiveTurnsStore.getState().finish(key, 'done');
      }
    } finally {
      abortRef.current = null;
      if (activeMode !== 'chat') branch.onProposals?.();
    }
  };

  const handleSend = (explicitText?: string) => {
    const text = (typeof explicitText === 'string' ? explicitText : input).trim();
    if (!text || streaming) return;

    setInput('');
    setError(null);
    setIsAtBottom(true);
    requestAnimationFrame(scrollToBottomInstant);

    if (branch) {
      const command = /^\/(chat|auto|plan)\b\s*([\s\S]*)$/i.exec(text);
      if (command) {
        const next = command[1]!.toLowerCase() as ChatMode;
        const rest = (command[2] ?? '').trim();
        branch.onModeChange?.(next);
        if (!rest) return;
        void sendBranchTurn(next === 'plan' ? `/plan ${rest}` : rest, next);
        return;
      }
      void sendBranchTurn(text, branch.mode);
      return;
    }

    void sendConversationTurn(text);
  };

  const handleStop = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      if (liveTurnKey) useLiveTurnsStore.getState().finish(liveTurnKey, 'done');
    }
  }, [liveTurnKey]);

  const branchAutoSentRef = useRef<string | null>(null);
  useEffect(() => {
    if (!branch?.autoSend || branchAutoSentRef.current === branch.autoSend || streaming) return;
    branchAutoSentRef.current = branch.autoSend;
    branch.onAutoSent?.();
    void sendBranchTurn(branch.autoSend, branch.mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branch?.autoSend]);

  const renderedMessages = useMemo(() => {
    if (branch) return branch.messages;
    if (initialMessages.length > 0 && (!activeConversation || (activeConversation.messages?.length ?? 0) === 0)) {
      return [...initialMessages, ...localMessages];
    }
    const persisted = activeConversation?.messages ?? initialMessages;
    return [...persisted, ...localMessages];
  }, [branch, activeConversation, initialMessages, localMessages]);

  const personaPacks: PersonaPackOption[] = useMemo(
    () => packs.map((p) => ({
      id: p.id,
      name: p.name,
      label: p.name.toUpperCase(),
      desc: p.description ?? '',
    })),
    [packs],
  );

  const koalaPackId = packs.find((p) => p.slug === 'koala')?.id;
  const activePack = isBranch ? undefined : personaPacks.find((p) => p.id === koalaPackId);

  /** What actually answers: this conversation's pin, else the account default. Grove has no account-default fallback. */
  const effectiveModel = models.find((m) => m.id === (activeModelId ?? (isBranch ? null : accountDefaultId)));
  const modelLabel = effectiveModel
    ? modelOptionLabel(effectiveModel)
    : activeModelId ?? 'No model';

  /** The pack's real grant count — the composer used to show a hardcoded 13. */
  const toolCount = isBranch ? undefined : packs.find((p) => p.slug === 'koala')?.tools?.length;

  const liveTrees = useMemo(
    () => liveState.proposals.filter((p) => p.kind === 'tree').map((p) => p.payload),
    [liveState.proposals],
  );
  const liveSpecs = useMemo(
    () => liveState.proposals.filter((p) => p.kind === 'spec').map((p) => p.payload),
    [liveState.proposals],
  );
  const liveEscalations = useMemo(
    () => liveState.proposals.filter((p) => p.kind === 'escalation').map((p) => p.payload),
    [liveState.proposals],
  );
  const liveSecretRequests = useMemo(
    () => liveState.proposals.filter((p) => p.kind === 'secretRequest').map((p) => p.payload),
    [liveState.proposals],
  );

  const pendingCount = useMemo(() => pendingProposalsCount({
    liveTrees, persistedTrees: activeConversation?.proposedTrees,
    liveSpecs, persistedSpecs: activeConversation?.proposedSpecs,
    liveEscalations, persistedEscalations: activeConversation?.proposedEscalations,
    liveSecretRequests, persistedSecretRequests: activeConversation?.proposedSecretRequests,
  }), [liveTrees, liveSpecs, liveEscalations, liveSecretRequests, activeConversation]);

  /** Nothing to show YET is not the same as nothing to show — the hero would flash otherwise. */
  const isLoadingThread = !isBranch && loadingConversation && renderedMessages.length === 0 && !streaming;
  const isConversationEmpty = !isBranch && renderedMessages.length === 0 && !streaming && !isLoadingThread;

  const proposed = branch?.proposed ?? [];

  return (
    <div className="flex flex-col h-full min-h-0 w-full bg-[var(--bark-950,#090d0b)] text-slate-200 font-sans overflow-hidden">

      {isBranch ? (
        <div className="flex-none flex items-center justify-between gap-3 px-4 py-2 bg-[var(--bark-900,#111814)] border-b border-[var(--bark-800,#1b2620)] select-none font-sans">
          <div className="flex items-center gap-2 text-[11px] min-w-0">
            <span className={`font-mono ${branch!.mode === 'chat' ? 'text-slate-500' : branch!.mode === 'plan' ? 'text-emerald-400' : 'text-blue-400'}`}>
              /{branch!.mode}
            </span>
            <span className="text-slate-600">{MODE_HINT[branch!.mode]}</span>
            <span className="text-slate-700">·</span>
            {plannerPack ? (
              <button
                type="button"
                onClick={() => setShellView('lab')}
                title="This project type's planner pack — change it in Lab > Tree Types"
                className="flex items-center gap-1 text-slate-400 hover:text-emerald-300 truncate cursor-pointer"
              >
                <Sparkles size={11} className="text-emerald-500 shrink-0" />
                <span className="truncate">Answering: {plannerPack.name}</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setShellView('lab')}
                title="No planner pack is assigned to this project type — set one in Lab > Tree Types"
                className="flex items-center gap-1 text-amber-500/90 hover:text-amber-400 truncate cursor-pointer"
              >
                <AlertTriangle size={11} className="shrink-0" />
                <span className="truncate">No planner pack assigned</span>
              </button>
            )}
          </div>
          <div className="flex items-center gap-2 relative">
            {models.length > 0 && (
              <button
                type="button"
                onClick={() => setShowModelDrawer(true)}
                title="Which model answers on this branch"
                className="flex items-center gap-1.5 px-2 py-1 rounded bg-[var(--bark-950,#090d0b)] hover:bg-[var(--bark-800,#1b2620)] border border-[var(--bark-700,#24332b)] text-[11px] text-slate-300 hover:text-white transition-colors max-w-[220px] truncate"
              >
                {modelLabel}
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="flex-none flex items-center justify-between gap-3 px-4 py-2.5 bg-[var(--bark-900,#111814)] border-b border-[var(--bark-800,#1b2620)] select-none font-sans">

          <div className="flex items-center gap-2">

            {!hideSidebar && (
              <button
                type="button"
                aria-label="Toggle history"
                onClick={() => setShowHistory(!showHistory)}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs transition-colors border cursor-pointer ${
                  showHistory
                    ? 'bg-[var(--bark-800,#1b2620)] text-emerald-300 border-emerald-500/50'
                    : 'bg-[var(--bark-950,#090d0b)] text-slate-300 border-[var(--bark-700,#24332b)] hover:text-white'
                }`}
                title="Toggle chat history archive"
              >
                <History size={13} className={showHistory ? 'text-emerald-400' : 'text-slate-400'} />
                <span className="hidden sm:inline">History</span>
              </button>
            )}

            <div className="relative">
              <button
                type="button"
                onClick={() => setShowDropdown(!showDropdown)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-[var(--bark-950,#090d0b)] hover:bg-[var(--bark-800,#1b2620)] border border-[var(--bark-700,#24332b)] text-xs text-slate-200 max-w-[220px] truncate cursor-pointer"
              >
                <span className="truncate">{activeConversation?.title || 'Current Thread'}</span>
                <ChevronDown size={12} className="text-slate-400 shrink-0" />
              </button>

              {showDropdown && (
                <div className="absolute top-full left-0 mt-1 w-64 max-h-60 overflow-y-auto bg-[var(--bark-900,#111814)] border border-[var(--bark-700,#24332b)] rounded-md shadow-lg p-1 z-50 text-xs">
                  <div className="text-[10px] text-slate-500 uppercase tracking-wider px-2 py-1 font-semibold">
                    Conversations
                  </div>
                  <div className="space-y-0.5">
                    {conversations.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => {
                          setSelectedConvId(c.id);
                          onConversationChange?.(c.id);
                          setShowDropdown(false);
                          setLocalMessages([]);
                        }}
                        className={`w-full text-left px-2 py-1.5 rounded flex items-center justify-between transition-colors cursor-pointer ${
                          c.id === selectedConvId
                            ? 'bg-emerald-950/60 text-emerald-300 font-medium'
                            : 'text-slate-300 hover:bg-[var(--bark-800,#1b2620)]'
                        }`}
                      >
                        <span className="truncate mr-2">{c.title || 'Untitled'}</span>
                        <span className="text-[10px] text-slate-500 shrink-0 font-mono">
                          {c.messageCount ?? c.messages?.length ?? 0}m
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {activeConversation?.isEscalated && (
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-amber-500/15 border border-amber-500/40 text-amber-300 text-[11px] font-mono select-none">
                <ShieldAlert size={12} className="text-amber-400" />
                <span>ELEVATED ({activeConversation.escalatedScope ?? 'cluster-read'})</span>
              </div>
            )}
            {!hideSidebar && !isBranch && (
              <button
                type="button"
                aria-label="Toggle proposals"
                onClick={() => setShowProposals(!showProposals)}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs transition-colors border cursor-pointer ${
                  showProposals
                    ? 'bg-[var(--bark-800,#1b2620)] text-emerald-300 border-emerald-500/50'
                    : 'bg-[var(--bark-950,#090d0b)] text-slate-300 border-[var(--bark-700,#24332b)] hover:text-white'
                }`}
                title="Toggle proposals"
              >
                <Inbox size={13} className={showProposals ? 'text-emerald-400' : 'text-slate-400'} />
                <span className="hidden sm:inline">Proposals</span>
                {pendingCount > 0 && (
                  <span className="text-[10px] text-slate-400 bg-[var(--bark-950,#090d0b)] px-1.5 py-0.5 rounded border border-[var(--bark-800,#1b2620)] font-mono">
                    {pendingCount}
                  </span>
                )}
              </button>
            )}
            <button
              type="button"
              onClick={() => createMutation.mutate()}
              disabled={createMutation.isPending}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-md text-xs font-medium transition-colors cursor-pointer"
            >
              <Plus size={13} />
              <span>New Chat</span>
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 flex flex-col sm:flex-row overflow-hidden relative">

        {!hideSidebar && !isBranch && (
          <CollapsibleHistoryList
            conversations={conversations}
            activeId={selectedConvId ?? undefined}
            isOpen={showHistory}
            onToggle={() => setShowHistory(false)}
            onSelect={(id) => {
              setSelectedConvId(id);
              onConversationChange?.(id);
              setLocalMessages([]);
            }}
            onNewChat={() => createMutation.mutate()}
            onDelete={(id) => deleteMutation.mutate(id)}
          />
        )}

        <div className="flex-1 flex flex-col h-full min-h-0 overflow-hidden bg-[var(--bark-950,#090d0b)] relative">

          {isConversationEmpty ? (
            <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 flex flex-col justify-center items-center">
              <div className="w-full max-w-3xl space-y-6">
                <ChatHero
                  packName={activePack?.name ?? 'Koala'}
                  onSelectPrompt={(p) => handleSend(p)}
                  onOpenPersona={() => setShowPersonaDrawer(true)}
                />

                <ChatComposer
                  input={input}
                  onChangeInput={setInput}
                  onSend={handleSend}
                  onStop={handleStop}
                  isStreaming={streaming}
                  activePack={activePack}
                  onOpenPersonaDrawer={() => setShowPersonaDrawer(true)}
                  {...(toolCount !== undefined ? { toolCount } : {})}
                  modelLabel={modelLabel}
                  onOpenModelDrawer={() => setShowModelDrawer(true)}
                />
              </div>
            </div>
          ) : (
            <>
              <div
                ref={scrollRef}
                onScroll={handleFeedScroll}
                className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-8 py-2 relative"
              >
                <div className="max-w-4xl mx-auto w-full space-y-0 pb-36">
                  {isLoadingThread && <KoalaLoading label="Fetching this conversation…" />}

                  {isBranch && renderedMessages.length === 0 && !streaming && (
                    <div className="flex flex-col items-center justify-center gap-3 text-center py-16">
                      <KoalaSpot size={88} mood="idle" className="sway opacity-80" />
                      <p className="text-slate-500 text-sm">Ask me something.</p>
                      <p className="text-slate-600 text-[11px] font-mono">/chat · /auto · /plan</p>
                    </div>
                  )}

                  {renderedMessages.map((msg, idx) => (
                    <ChatMessageRow
                      key={idx}
                      message={msg}
                      packLabel={isBranch ? 'Assistant' : (activePack?.label ?? '')}
                      isStreaming={isBranch && streaming && idx === renderedMessages.length - 1}
                    />
                  ))}

                  {!isBranch && streaming && (
                    <ChatMessageRow
                      message={{
                        role: 'assistant',
                        content: liveState.live,
                        reasoning: liveState.liveThinking,
                        enabled: liveState.enabled,
                        toolCalls: liveState.tools,
                      }}
                      packLabel={activePack?.label ?? ''}
                      isStreaming={true}
                    />
                  )}

                  {isBranch && proposed.length > 0 && (
                    <div className="mt-3 shrink-0 rounded-xl border border-[var(--leaf-stem)]/40 bg-[var(--leaf-stem)]/10 p-3">
                      <div className="flex items-center gap-2 mb-2">
                        <Sprout size={13} className="text-[var(--leaf-light)]" />
                        <h3 className="text-[11px] uppercase tracking-widest text-[var(--leaf-light)] flex-1">
                          {proposed.length} sprouting
                        </h3>
                        {proposed.length > 1 && branch?.onAcceptAll && (
                          <button
                            onClick={branch.onAcceptAll}
                            disabled={proposed.some((p) => !p.packId)}
                            title={proposed.some((p) => !p.packId) ? 'Some of these have nobody assigned' : undefined}
                            className="text-[11px] px-2 py-1 rounded-lg bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] disabled:opacity-40 text-white"
                          >
                            Accept all
                          </button>
                        )}
                      </div>
                      <ul className="space-y-1.5 max-h-52 overflow-y-auto">
                        {proposed.map((p) => (
                          <li key={p.id} className="flex items-start gap-2 rounded-lg bg-[var(--bark-800)] px-3 py-2">
                            <div className="min-w-0 flex-1">
                              <p className="text-[13px] text-slate-200">{p.title}</p>
                              {p.body && <p className="text-[11px] text-slate-500 mt-0.5 leading-relaxed line-clamp-2">{p.body}</p>}
                              {!p.packId && (
                                <p className="text-[11px] text-amber-400/90 mt-1 flex items-center gap-1">
                                  <AlertTriangle size={11} /> needs a persona before it can run
                                </p>
                              )}
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              <button onClick={() => branch?.onAccept?.(p.id)} disabled={!p.packId}
                                title={p.packId ? 'Accept — starts the work' : 'Assign a persona first'}
                                className="p-1 rounded-md text-[var(--leaf-light)] hover:bg-[var(--bark-700)] disabled:opacity-30"><Check size={14} /></button>
                              <button onClick={() => branch?.onReject?.(p.id)} title="Reject"
                                className="p-1 rounded-md text-slate-500 hover:text-red-400 hover:bg-[var(--bark-700)]"><X size={14} /></button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {overthinkWarning && (
                    <div className="w-full p-3 my-2 rounded-md bg-amber-950/60 border border-amber-500/50 text-amber-200 font-sans text-xs flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2 min-w-0">
                        <AlertTriangle size={14} className="text-amber-400 shrink-0" />
                        <span className="truncate">This looks like it might be an overthinking loop ({overthinkWarning}). Stop it?</span>
                      </div>
                      <button
                        type="button"
                        onClick={handleStop}
                        className="shrink-0 px-2.5 py-1 rounded bg-amber-600 hover:bg-amber-500 text-white transition-colors cursor-pointer flex items-center gap-1 text-xs font-medium"
                      >
                        <Square size={11} />
                        <span>Stop</span>
                      </button>
                    </div>
                  )}

                  {error && (
                    <div className="w-full p-3 my-2 rounded-md bg-red-950/60 border border-red-500/50 text-red-300 font-sans text-xs flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <AlertTriangle size={14} className="text-red-400 shrink-0" />
                        <span>{error}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setError(null)}
                        className="text-red-400 hover:text-red-200 cursor-pointer"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  )}

                  <div ref={bottomAnchorRef} className="h-4 w-full flex-none pointer-events-none" />
                </div>
              </div>

              <div className="absolute bottom-0 left-0 right-0 pointer-events-none bg-gradient-to-t from-[var(--bark-950,#090d0b)] via-[var(--bark-950,#090d0b)]/95 to-transparent pt-8 pb-4 px-4 sm:px-8 z-20">

                {!isAtBottom && renderedMessages.length > 0 && (
                  <div className="flex justify-center mb-2">
                    <button
                      type="button"
                      onClick={scrollToBottom}
                      aria-label="Jump to latest"
                      className="pointer-events-auto flex items-center gap-1.5 px-3 py-1 rounded-full bg-[var(--bark-900,#111814)] hover:bg-[var(--bark-800,#1b2620)] border border-slate-700 text-slate-300 text-xs shadow-md transition-colors cursor-pointer"
                    >
                      <ArrowDown size={12} className="text-emerald-400" />
                      <span>Jump to latest</span>
                    </button>
                  </div>
                )}

                <div className="max-w-4xl mx-auto pointer-events-auto">
                  <ChatComposer
                    input={input}
                    onChangeInput={setInput}
                    onSend={handleSend}
                    onStop={handleStop}
                    isStreaming={streaming}
                    {...(isBranch ? {} : { activePack, onOpenPersonaDrawer: () => setShowPersonaDrawer(true) })}
                    {...(toolCount !== undefined ? { toolCount } : {})}
                    {...(isBranch
                      ? { placeholder: 'Send a message…  (/chat, /auto or /plan to switch mode)' }
                      : { modelLabel, onOpenModelDrawer: () => setShowModelDrawer(true) })}
                  />
                </div>
              </div>
            </>
          )}
        </div>

        {!hideSidebar && !isBranch && (
          <ProposalsSidebar
            isOpen={showProposals}
            onToggle={() => setShowProposals(false)}
            liveTrees={liveTrees}
            persistedTrees={activeConversation?.proposedTrees}
            onAcceptTree={(id) => selectedConvId && acceptTreeMutation.mutate({ convId: selectedConvId, proposalId: id })}
            onDismissTree={(id) => selectedConvId && dismissTreeMutation.mutate({ convId: selectedConvId, proposalId: id })}
            treeActionPending={acceptTreeMutation.isPending || dismissTreeMutation.isPending}
            liveSpecs={liveSpecs}
            persistedSpecs={activeConversation?.proposedSpecs}
            onAcceptSpec={(id) => selectedConvId && acceptSpecMutation.mutate({ convId: selectedConvId, proposalId: id })}
            onDismissSpec={(id) => selectedConvId && dismissSpecMutation.mutate({ convId: selectedConvId, proposalId: id })}
            specActionPending={acceptSpecMutation.isPending || dismissSpecMutation.isPending}
            liveEscalations={liveEscalations}
            persistedEscalations={activeConversation?.proposedEscalations}
            onAcceptEscalation={(id) => {
              const cid = selectedConvId || activeConversation?.id;
              if (cid) acceptEscalationMutation.mutate({ convId: cid, proposalId: id });
            }}
            onDenyEscalation={(id) => {
              const cid = selectedConvId || activeConversation?.id;
              if (cid) denyEscalationMutation.mutate({ convId: cid, proposalId: id });
            }}
            escalationActionPending={acceptEscalationMutation.isPending || denyEscalationMutation.isPending}
            liveSecretRequests={liveSecretRequests}
            persistedSecretRequests={activeConversation?.proposedSecretRequests}
            onSubmitSecret={(id, value) => {
              const cid = selectedConvId || activeConversation?.id;
              if (cid) submitSecretMutation.mutate({ convId: cid, requestId: id, value });
            }}
            onDismissSecret={(id) => {
              const cid = selectedConvId || activeConversation?.id;
              if (cid) dismissSecretMutation.mutate({ convId: cid, requestId: id });
            }}
            secretActionPending={submitSecretMutation.isPending || dismissSecretMutation.isPending}
          />
        )}
      </div>

      <ModelConfigDrawer
        isOpen={showModelDrawer}
        onClose={() => setShowModelDrawer(false)}
        selectedModelId={activeModelId}
        onSelectModel={setActiveModelId}
      />

      {!isBranch && (
        /*
          General chat always runs as koala — there is nothing else to pick here any more.
          `onSelectPack` is a no-op rather than removed outright: the drawer still doubles as
          koala's own config viewer/editor, which stays useful even with no switching.
        */
        <PersonaConfigDrawer
          isOpen={showPersonaDrawer}
          onClose={() => setShowPersonaDrawer(false)}
          activePackId="koala"
          onSelectPack={() => {}}
        />
      )}
    </div>
  );
}
