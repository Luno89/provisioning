/* ═══════════════ ChatSurface — unified persona-pack chat surface ═══════════════ */

/**
 * A comprehensive, unified chat surface for ANY persona pack.
 *
 * Synthesizes 30 years of chat interface evolution:
 * - ChatGPT-style centered canvas with transition from centered hero to floating bottom capsule
 * - Claude-style serene typography, thinking disclosure, and rich markdown
 * - Hermes-style real-time tool execution telemetry and deep observability
 * - Full conversation vault persistence, proposal cards, and routing integration
 */
import { useState, useCallback, useEffect, useLayoutEffect, useRef, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus, History, ChevronDown, Sparkles, Sliders, ArrowDown, AlertTriangle, X, ShieldAlert,
  Key, Eye, EyeOff, Lock, Check,
} from 'lucide-react';
import {
  openChatPackStream,
  listChatConversations,
  getChatConversation,
  createChatConversation,
  deleteChatConversation,
  acceptTreeProposal,
  acceptSpecProposal,
  acceptEscalationProposal,
  denyEscalationProposal,
  submitSecretRequest,
  dismissSecretRequest,
  chatPackKeys,
  type ChatConversation,
  type ProposedEscalationRecord,
  type ProposedSecretRequestRecord,
} from '../api/chat-pack.js';
import { reduceUnifiedFrames, emptyChatRenderState, type ChatRenderState } from '../lib/chat-unified-reducer.js';
import SpecProposal, { type Spec } from './SpecProposal.js';
import CollapsibleHistoryList from './CollapsibleHistoryList.js';
import PersonaConfigDrawer from './PersonaConfigDrawer.js';
import ChatHero from './Chat/ChatHero.js';
import ChatComposer, { type PersonaPackOption } from './Chat/ChatComposer.js';
import ChatMessageRow, { type ChatMessageData, ProposedTreeCard } from './Chat/ChatMessageRow.js';
import { errorMessage } from '../api/client.js';
import { listPacks, packKeys, type PersonaPack } from '../api/packs';

export interface ProposedTreeRecord {
  id: string;
  name: string;
  type: string;
  goal: string;
  treeId?: string | undefined;
}

export interface ProposedSpecRecord {
  id: string;
  spec: Spec;
  acceptedAt?: string | undefined;
}

export interface ChatMessageRecord extends ChatMessageData {
  notice?: boolean | undefined;
  handoff?: boolean | undefined;
}

export interface ChatSurfaceProps {
  /** The persona pack ID (e.g. 'koala', 'researcher', 'harness') */
  packId?: string | undefined;
  /** Active conversation ID */
  conversationId?: string | undefined;
  /** Session ID for dynamic tool discovery */
  sessionId?: string | undefined;
  /** Optional model override */
  modelId?: string | undefined;
  /** Initial messages for hydration / standalone display */
  initialMessages?: ChatMessageRecord[] | undefined;
  /** Hide sidebar / tree toggle if embedded in another panel */
  hideSidebar?: boolean | undefined;
  /** Callback when a conversation is switched or created */
  onConversationChange?: ((conversationId: string | null) => void) | undefined;
  /** Callback when a project tree proposal is accepted to navigate to Grove */
  onOpenTree?: ((treeId: string) => void) | undefined;
}

export default function ChatSurface({
  packId: initialPackId = 'koala',
  conversationId: externalConvId,
  sessionId: externalSessionId,
  modelId,
  initialMessages = [],
  hideSidebar = false,
  onConversationChange,
  onOpenTree,
}: ChatSurfaceProps) {
  const qc = useQueryClient();
  const [currentPackId, setCurrentPackId] = useState<string>(initialPackId);
  const [selectedConvId, setSelectedConvId] = useState<string | null>(externalConvId ?? null);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveState, setLiveState] = useState<ChatRenderState>(emptyChatRenderState);
  const [localMessages, setLocalMessages] = useState<ChatMessageRecord[]>([]);

  // UI view state
  const [showHistory, setShowHistory] = useState<boolean>(false);
  const [showDropdown, setShowDropdown] = useState<boolean>(false);
  const [showPersonaDrawer, setShowPersonaDrawer] = useState<boolean>(false);
  const [isAtBottom, setIsAtBottom] = useState<boolean>(true);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bottomAnchorRef = useRef<HTMLDivElement | null>(null);
  const liveStateRef = useRef<ChatRenderState>(emptyChatRenderState);
  const localSessionId = useRef(externalSessionId ?? Math.random().toString(36).slice(2));

  // Sync external props
  useEffect(() => {
    if (externalConvId !== undefined) {
      setSelectedConvId(externalConvId);
    }
  }, [externalConvId]);

  useEffect(() => {
    if (initialPackId) {
      setCurrentPackId(initialPackId);
    }
  }, [initialPackId]);

  // The pack catalogue — what the picker offers and what the server will actually accept.
  const { data: packs = [] } = useQuery<PersonaPack[]>({
    queryKey: packKeys.list(),
    queryFn: listPacks,
  });

  // Fetch conversation list
  const { data: conversations = [] } = useQuery<ChatConversation[]>({
    queryKey: chatPackKeys.conversations(),
    queryFn: listChatConversations,
  });

  // Fetch active conversation detail
  const { data: activeConversation } = useQuery<ChatConversation | null>({
    queryKey: chatPackKeys.conversation(selectedConvId ?? ''),
    queryFn: () => (selectedConvId ? getChatConversation(selectedConvId) : null),
    enabled: Boolean(selectedConvId),
  });

  // Clear local messages when active conversation catches up
  useEffect(() => {
    if (activeConversation && (activeConversation.messages?.length ?? 0) > 0) {
      setLocalMessages([]);
    }
  }, [activeConversation]);

  // Auto-select most recent conversation if none selected and conversations exist
  useEffect(() => {
    if (!selectedConvId && conversations.length > 0 && !externalConvId) {
      const first = conversations[0];
      if (first) {
        setSelectedConvId(first.id);
        onConversationChange?.(first.id);
      }
    }
  }, [conversations, selectedConvId, externalConvId, onConversationChange]);

  // Create conversation mutation
  const createMutation = useMutation({
    mutationFn: () => createChatConversation('New conversation'),
    onSuccess: (newConv) => {
      qc.invalidateQueries({ queryKey: chatPackKeys.conversations() });
      setSelectedConvId(newConv.id);
      setLocalMessages([]);
      setLiveState(emptyChatRenderState);
      liveStateRef.current = emptyChatRenderState;
      setError(null);
      onConversationChange?.(newConv.id);
    },
  });

  // Delete conversation mutation
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

  // Accept Project Tree mutation
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
  });

  // Accept App Spec mutation
  const acceptSpecMutation = useMutation({
    mutationFn: ({ convId, proposalId }: { convId: string; proposalId: string }) =>
      acceptSpecProposal(convId, proposalId),
    onSuccess: (_, variables) => {
      qc.invalidateQueries({ queryKey: chatPackKeys.conversation(variables.convId) });
      qc.invalidateQueries({ queryKey: chatPackKeys.conversations() });
    },
  });

  // Accept Escalation mutation
  const acceptEscalationMutation = useMutation({
    mutationFn: ({ convId, proposalId }: { convId: string; proposalId: string }) =>
      acceptEscalationProposal(convId, proposalId),
    onSuccess: (_, variables) => {
      qc.invalidateQueries({ queryKey: chatPackKeys.conversation(variables.convId) });
      qc.invalidateQueries({ queryKey: chatPackKeys.conversations() });
    },
  });

  // Deny Escalation mutation
  const denyEscalationMutation = useMutation({
    mutationFn: ({ convId, proposalId }: { convId: string; proposalId: string }) =>
      denyEscalationProposal(convId, proposalId),
    onSuccess: (_, variables) => {
      qc.invalidateQueries({ queryKey: chatPackKeys.conversation(variables.convId) });
      qc.invalidateQueries({ queryKey: chatPackKeys.conversations() });
    },
  });

  // Submit Secret mutation
  const submitSecretMutation = useMutation({
    mutationFn: ({ convId, requestId, value }: { convId: string; requestId: string; value: string }) =>
      submitSecretRequest(convId, requestId, value),
    onSuccess: (_, variables) => {
      qc.invalidateQueries({ queryKey: chatPackKeys.conversation(variables.convId) });
      qc.invalidateQueries({ queryKey: chatPackKeys.conversations() });
    },
  });

  // Dismiss Secret mutation
  const dismissSecretMutation = useMutation({
    mutationFn: ({ convId, requestId }: { convId: string; requestId: string }) =>
      dismissSecretRequest(convId, requestId),
    onSuccess: (_, variables) => {
      qc.invalidateQueries({ queryKey: chatPackKeys.conversation(variables.convId) });
      qc.invalidateQueries({ queryKey: chatPackKeys.conversations() });
    },
  });

  // Instant scroll to bottom without animation delay
  const scrollToBottomInstant = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  // Smooth scroll helper for manual user click
  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: 'smooth',
      });
      setIsAtBottom(true);
    }
  }, []);

  // Track scroll position to pause auto-scroll if user scrolls up
  const handleFeedScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 60;
    setIsAtBottom(atBottom);
  }, []);

  // Auto-scroll on updates when at bottom
  useLayoutEffect(() => {
    if (isAtBottom) {
      scrollToBottomInstant();
    }
  }, [activeConversation?.messages, localMessages, liveState.live, liveState.liveThinking, liveState.tools, streaming, isAtBottom, scrollToBottomInstant]);

  // ResizeObserver to ensure asynchronous content/markdown expansions stick to bottom
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

  // Handle Send
  const handleSend = useCallback(async (explicitText?: string) => {
    const text = (typeof explicitText === 'string' ? explicitText : input).trim();
    if (!text || streaming) return;

    setError(null);
    setInput('');
    setIsAtBottom(true);
    requestAnimationFrame(scrollToBottomInstant);

    // Ensure we have a conversationId
    let targetConvId = selectedConvId;
    if (!targetConvId) {
      try {
        const created = await createChatConversation('New conversation');
        targetConvId = created.id;
        setSelectedConvId(created.id);
        onConversationChange?.(created.id);
        qc.invalidateQueries({ queryKey: chatPackKeys.conversations() });
      } catch (err) {
        setError(`Failed to create conversation: ${errorMessage(err)}`);
        return;
      }
    }

    // Optimistically render user message
    const userMsg: ChatMessageRecord = {
      role: 'user',
      content: text,
      at: new Date().toISOString(),
    };
    setLocalMessages((prev) => [...prev, userMsg]);
    setLiveState(emptyChatRenderState);
    liveStateRef.current = emptyChatRenderState;
    setStreaming(true);

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const response = await openChatPackStream(
        {
          packId: currentPackId,
          conversationId: targetConvId,
          message: text,
          sessionId: localSessionId.current,
          modelId,
        },
        abort.signal,
      );

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(errText || `Server responded with ${response.status}`);
      }

      if (response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data: ')) continue;
            const payload = trimmed.slice(6).trim();
            if (!payload || payload === '[DONE]') continue;

            try {
              const frame = JSON.parse(payload);
              const nextState = reduceUnifiedFrames(liveStateRef.current, frame);
              liveStateRef.current = nextState;
              setLiveState({ ...nextState });
            } catch {
              // Ignore malformed SSE lines
            }
          }
        }
      }

      // Finalize turn into local messages
      const finalState = liveStateRef.current;
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

      setLiveState(emptyChatRenderState);
      liveStateRef.current = emptyChatRenderState;

      qc.invalidateQueries({ queryKey: chatPackKeys.conversation(targetConvId) });
      qc.invalidateQueries({ queryKey: chatPackKeys.conversations() });
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        // Stream aborted by user
      } else {
        setError(`Turn failed: ${errorMessage(err)}`);
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }, [input, streaming, selectedConvId, currentPackId, modelId, onConversationChange, qc, scrollToBottomInstant]);

  const handleStop = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      setStreaming(false);
    }
  }, []);

  // Assemble full message list: persisted + local unsaved + initialMessages
  const renderedMessages = useMemo(() => {
    if (initialMessages.length > 0 && (!activeConversation || (activeConversation.messages?.length ?? 0) === 0)) {
      return [...initialMessages, ...localMessages];
    }
    const persisted = activeConversation?.messages ?? initialMessages;
    return [...persisted, ...localMessages];
  }, [activeConversation, initialMessages, localMessages]);

  /**
   * The packs, from the server.
   *
   * This was a literal array of three while the server's registry held two, and the third —
   * `researcher` — existed in neither. Selecting it posted to a pack the server had never heard of.
   * The list is a catalogue now, so what the picker offers and what exists are the same set.
   */
  const personaPacks: PersonaPackOption[] = useMemo(
    () => packs.map((p) => ({
      id: p.slug,
      name: p.name,
      label: p.name.toUpperCase(),
      desc: p.description ?? '',
    })),
    [packs],
  );

  /**
   * Undefined while the catalogue is still loading, or when the URL names a pack that is gone.
   *
   * Deliberately NOT `?? personaPacks[0]`. That fallback is what made the config drawer offer
   * Framer's settings under Koala's name: asked for something it could not find, it silently
   * showed the first record it had. A surface that cannot say what it is showing should say so.
   */
  const activePack = personaPacks.find((p) => p.id === currentPackId);

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

  const isConversationEmpty = renderedMessages.length === 0 && !streaming;

  return (
    <div className="flex flex-col h-full min-h-0 w-full bg-[var(--bark-950,#090d0b)] text-slate-200 font-sans overflow-hidden">
      
      {/* ── Top Header Bar ── */}
      <div className="flex-none flex items-center justify-between gap-3 px-4 py-2.5 bg-[var(--bark-900,#111814)] border-b border-[var(--bark-800,#1b2620)] select-none font-sans">
        
        {/* Left: History Toggle, Persona Switcher & Conversation Quick Switcher */}
        <div className="flex items-center gap-2">
          
          {/* History Drawer Toggle Button */}
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

          {/* Persona Tuning Drawer Button */}
          <div className="relative group">
            <button
              type="button"
              onClick={() => setShowPersonaDrawer(true)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-[var(--bark-950,#090d0b)] hover:bg-[var(--bark-800,#1b2620)] border border-[var(--bark-700,#24332b)] text-xs text-slate-200 transition-colors cursor-pointer"
              title="Configure persona directives and capability tools"
            >
              <Sparkles size={13} className="text-emerald-400" />
              <span className="font-medium">{activePack?.name ?? 'Loading…'}</span>
              <Sliders size={11} className="text-slate-400 ml-0.5" />
            </button>
          </div>

          {/* Quick Switcher Dropdown */}
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

        {/* Right: Escalation Badge & New Chat Action Button */}
        <div className="flex items-center gap-2">
          {activeConversation?.isEscalated && (
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-amber-500/15 border border-amber-500/40 text-amber-300 text-[11px] font-mono select-none">
              <ShieldAlert size={12} className="text-amber-400" />
              <span>ELEVATED ({activeConversation.escalatedScope ?? 'cluster-read'})</span>
            </div>
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

      {/* ── Main Responsive Workspace (Collapsible History List + Focus Chat) ── */}
      <div className="flex-1 min-h-0 flex flex-col sm:flex-row overflow-hidden relative">
        
        {/* ── Collapsible Chat History Drawer ── */}
        {!hideSidebar && (
          <CollapsibleHistoryList
            conversations={conversations}
            activeId={selectedConvId ?? undefined}
            isOpen={showHistory}
            onToggle={() => setShowHistory(false)}
            onSelect={(id) => {
              setSelectedConvId(id);
              onConversationChange?.(id);
            }}
            onNewChat={() => createMutation.mutate()}
            onDelete={(id) => deleteMutation.mutate(id)}
          />
        )}

        {/* ── Conversation Canvas & Docked Composer ── */}
        <div className="flex-1 flex flex-col h-full min-h-0 overflow-hidden bg-[var(--bark-950,#090d0b)] relative">
          
          {/* CASE A: Empty State */}
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
                  personaPacks={personaPacks}
                  onSelectPack={(id) => setCurrentPackId(id)}
                  onOpenPersonaDrawer={() => setShowPersonaDrawer(true)}
                />
              </div>
            </div>
          ) : (
            /* CASE B: Populated Conversation Feed with Bottom Docked Composer */
            <>
              {/* Feed Scroll View */}
              <div
                ref={scrollRef}
                onScroll={handleFeedScroll}
                className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-8 py-2 relative"
              >
                <div className="max-w-4xl mx-auto w-full space-y-0 pb-36">
                  {/* Rendered Transcript Messages */}
                  {renderedMessages.map((msg, idx) => (
                    <ChatMessageRow
                      key={idx}
                      message={msg}
                      packLabel={activePack?.label ?? ''}
                    />
                  ))}

                  {/* Live Streaming Turn */}
                  {streaming && (
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

                  {/* Live Project Proposals */}
                  {liveTrees.map((tree: any) => (
                    <ProposedTreeCard
                      key={tree.id}
                      proposal={tree}
                      onAccept={(id) =>
                        selectedConvId &&
                        acceptTreeMutation.mutate({ convId: selectedConvId, proposalId: id })
                      }
                      isPending={acceptTreeMutation.isPending}
                    />
                  ))}

                  {/* Live App Spec Proposals */}
                  {liveSpecs.map((spec: any) => (
                    <div key={spec.id} className="my-2">
                      <SpecProposal
                        spec={spec.spec}
                        onAccept={() => {
                          if (selectedConvId) {
                            acceptSpecMutation.mutate({ convId: selectedConvId, proposalId: spec.id });
                          }
                        }}
                      />
                    </div>
                  ))}

                  {/* Live Privilege Escalation Proposals */}
                  {liveEscalations.map((esc: any) => (
                    <EscalationProposalCard
                      key={esc.id}
                      proposal={esc}
                      onAccept={(id) => {
                        const cid = selectedConvId || activeConversation?.id;
                        if (cid) {
                          acceptEscalationMutation.mutate({ convId: cid, proposalId: id });
                        }
                      }}
                      onDeny={(id) => {
                        const cid = selectedConvId || activeConversation?.id;
                        if (cid) {
                          denyEscalationMutation.mutate({ convId: cid, proposalId: id });
                        }
                      }}
                      isPending={acceptEscalationMutation.isPending || denyEscalationMutation.isPending}
                    />
                  ))}

                  {/* Live Secret Requests */}
                  {liveSecretRequests.map((req: any) => (
                    <SecretRequestCard
                      key={req.id}
                      request={req}
                      onSubmit={(id, value) => {
                        const cid = selectedConvId || activeConversation?.id;
                        if (cid) {
                          submitSecretMutation.mutate({ convId: cid, requestId: id, value });
                        }
                      }}
                      onDismiss={(id) => {
                        const cid = selectedConvId || activeConversation?.id;
                        if (cid) {
                          dismissSecretMutation.mutate({ convId: cid, requestId: id });
                        }
                      }}
                      isPending={submitSecretMutation.isPending || dismissSecretMutation.isPending}
                    />
                  ))}

                  {/* Persisted Proposals for this conversation */}
                  {activeConversation?.proposedTrees &&
                    activeConversation.proposedTrees.length > 0 &&
                    !streaming && (
                      <div className="w-full space-y-2 pt-3 border-t border-[var(--bark-800,#1b2620)]">
                        <div className="text-[10px] font-mono font-bold text-amber-400 uppercase tracking-wider flex items-center gap-1.5">
                          <span>PROPOSED PROJECT TREES</span>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          {activeConversation.proposedTrees.map((p: any) => (
                            <ProposedTreeCard
                              key={p.id}
                              proposal={p}
                              onAccept={(id) =>
                                selectedConvId &&
                                acceptTreeMutation.mutate({ convId: selectedConvId, proposalId: id })
                              }
                              isPending={acceptTreeMutation.isPending}
                            />
                          ))}
                        </div>
                      </div>
                    )}

                  {/* Persisted Escalations for this conversation */}
                  {activeConversation?.proposedEscalations &&
                    activeConversation.proposedEscalations.length > 0 &&
                    !streaming && (
                      <div className="w-full space-y-2 pt-3 border-t border-[var(--bark-800,#1b2620)]">
                        <div className="text-[10px] font-mono font-bold text-amber-400 uppercase tracking-wider flex items-center gap-1.5">
                          <ShieldAlert size={12} />
                          <span>PRIVILEGE ESCALATION REQUESTS</span>
                        </div>
                        <div className="space-y-2">
                          {activeConversation.proposedEscalations.map((esc) => (
                            <EscalationProposalCard
                              key={esc.id}
                              proposal={esc}
                              onAccept={(id) => {
                                const cid = activeConversation.id || selectedConvId;
                                if (cid) {
                                  acceptEscalationMutation.mutate({ convId: cid, proposalId: id });
                                }
                              }}
                              onDeny={(id) => {
                                const cid = activeConversation.id || selectedConvId;
                                if (cid) {
                                  denyEscalationMutation.mutate({ convId: cid, proposalId: id });
                                }
                              }}
                              isPending={acceptEscalationMutation.isPending || denyEscalationMutation.isPending}
                            />
                          ))}
                        </div>
                      </div>
                    )}

                  {/* Persisted Secret Requests for this conversation */}
                  {activeConversation?.proposedSecretRequests &&
                    activeConversation.proposedSecretRequests.length > 0 &&
                    !streaming && (
                      <div className="w-full space-y-2 pt-3 border-t border-[var(--bark-800,#1b2620)]">
                        <div className="text-[10px] font-mono font-bold text-emerald-400 uppercase tracking-wider flex items-center gap-1.5">
                          <Key size={12} />
                          <span>VAULTED & REQUESTED SECRETS</span>
                        </div>
                        <div className="space-y-2">
                          {activeConversation.proposedSecretRequests.map((req) => (
                            <SecretRequestCard
                              key={req.id}
                              request={req}
                              onSubmit={(id, value) => {
                                const cid = activeConversation.id || selectedConvId;
                                if (cid) {
                                  submitSecretMutation.mutate({ convId: cid, requestId: id, value });
                                }
                              }}
                              onDismiss={(id) => {
                                const cid = activeConversation.id || selectedConvId;
                                if (cid) {
                                  dismissSecretMutation.mutate({ convId: cid, requestId: id });
                                }
                              }}
                              isPending={submitSecretMutation.isPending || dismissSecretMutation.isPending}
                            />
                          ))}
                        </div>
                      </div>
                    )}

                  {/* Error Notification */}
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

                  {/* Bottom Anchor Sentinel */}
                  <div ref={bottomAnchorRef} className="h-4 w-full flex-none pointer-events-none" />
                </div>
              </div>

              {/* Bottom Docked Composer Bar */}
              <div className="absolute bottom-0 left-0 right-0 pointer-events-none bg-gradient-to-t from-[var(--bark-950,#090d0b)] via-[var(--bark-950,#090d0b)]/95 to-transparent pt-8 pb-4 px-4 sm:px-8 z-20">
                
                {/* Jump to Latest Button */}
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

                {/* Docked Composer Container */}
                <div className="max-w-4xl mx-auto pointer-events-auto">
                  <ChatComposer
                    input={input}
                    onChangeInput={setInput}
                    onSend={handleSend}
                    onStop={handleStop}
                    isStreaming={streaming}
                    activePack={activePack}
                    personaPacks={personaPacks}
                    onSelectPack={(id) => setCurrentPackId(id)}
                    onOpenPersonaDrawer={() => setShowPersonaDrawer(true)}
                  />
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Persona & Tools Configuration Drawer ── */}
      <PersonaConfigDrawer
        isOpen={showPersonaDrawer}
        onClose={() => setShowPersonaDrawer(false)}
        activePackId={currentPackId}
        onSelectPack={(packId) => {
          setCurrentPackId(packId);
        }}
      />
    </div>
  );
}

export function EscalationProposalCard({
  proposal,
  onAccept,
  onDeny,
  isPending,
}: {
  proposal: ProposedEscalationRecord;
  onAccept: (id: string) => void;
  onDeny: (id: string) => void;
  isPending?: boolean;
}) {
  return (
    <div className="p-3.5 rounded-lg border border-amber-500/30 bg-amber-950/20 text-slate-200 text-[13px] flex flex-col gap-2 my-2 font-sans">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldAlert size={15} className="text-amber-400 shrink-0" />
          <span className="font-semibold text-amber-200">Privilege Escalation Requested</span>
        </div>
        <span className="text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
          {proposal.scope}
        </span>
      </div>
      <p className="text-slate-300 text-[12px] leading-relaxed">{proposal.reason}</p>
      {proposal.namespaces && proposal.namespaces.length > 0 && (
        <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
          <span>Target Namespaces:</span>
          <div className="flex gap-1 flex-wrap font-mono">
            {proposal.namespaces.map((ns) => (
              <span key={ns} className="px-1.5 py-0.5 bg-black/40 rounded border border-slate-700 text-slate-300 text-[10px]">
                {ns}
              </span>
            ))}
          </div>
        </div>
      )}
      {proposal.status === 'accepted' ? (
        <div className="text-[12px] text-emerald-400 font-medium mt-1 flex items-center gap-1">
          ✓ Granted at {new Date(proposal.acceptedAt || proposal.proposedAt).toLocaleTimeString()}
        </div>
      ) : proposal.status === 'denied' ? (
        <div className="text-[12px] text-red-400 font-medium mt-1">
          ✕ Request Denied
        </div>
      ) : (
        <div className="flex items-center gap-2 mt-1.5">
          <button
            type="button"
            onClick={() => onAccept(proposal.id)}
            disabled={isPending}
            className="px-3 py-1.5 rounded-md bg-amber-600 hover:bg-amber-500 text-white text-[12px] font-semibold transition-colors disabled:opacity-50 cursor-pointer"
          >
            Approve Escalation
          </button>
          <button
            type="button"
            onClick={() => onDeny(proposal.id)}
            disabled={isPending}
            className="px-3 py-1.5 rounded-md bg-[var(--bark-800,#1b2620)] hover:bg-[var(--bark-700,#24332b)] text-slate-300 text-[12px] transition-colors disabled:opacity-50 cursor-pointer"
          >
            Deny
          </button>
        </div>
      )}
    </div>
  );
}

export function SecretRequestCard({
  request,
  onSubmit,
  onDismiss,
  isPending,
}: {
  request: ProposedSecretRequestRecord;
  onSubmit: (id: string, value: string) => void;
  onDismiss: (id: string) => void;
  isPending?: boolean;
}) {
  const [value, setValue] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  return (
    <div className="p-3.5 rounded-lg border border-emerald-500/30 bg-emerald-950/20 text-slate-200 text-[13px] flex flex-col gap-2.5 my-2 font-sans">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Key size={15} className="text-emerald-400 shrink-0" />
          <span className="font-semibold text-emerald-200">
            {request.label || 'Secret Input Requested'}
          </span>
        </div>
        <span className="text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
          {request.key}
        </span>
      </div>

      <p className="text-slate-300 text-[12px] leading-relaxed">{request.description}</p>

      {request.projectId && (
        <div className="text-[11px] text-slate-400 font-mono flex items-center gap-1">
          <span className="text-slate-500">Project:</span> {request.projectId}
        </div>
      )}

      {request.status === 'fulfilled' ? (
        <div className="text-[12px] text-emerald-400 font-medium mt-1 flex items-center gap-1.5 bg-emerald-950/40 p-2 rounded border border-emerald-500/20 font-mono text-[11px]">
          <Check size={14} className="text-emerald-400 shrink-0" />
          <span>Encrypted & Vaulted in Infisical</span>
          {request.secretReference && (
            <span className="text-slate-400 ml-auto text-[10px]">({request.secretReference})</span>
          )}
        </div>
      ) : request.status === 'dismissed' ? (
        <div className="text-[12px] text-slate-400 font-medium mt-1 flex items-center gap-1 bg-slate-900/40 p-2 rounded border border-slate-800">
          ✕ Secret Request Dismissed
        </div>
      ) : (
        <div className="flex flex-col gap-2 mt-1">
          <div className="relative flex items-center">
            <input
              type={showPassword ? 'text' : 'password'}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={`Enter ${request.key}...`}
              className="w-full px-3 py-1.5 pr-9 rounded-md bg-black/50 border border-emerald-500/30 text-white font-mono text-xs focus:outline-none focus:border-emerald-400 placeholder:text-slate-500"
              disabled={isPending}
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-2 text-slate-400 hover:text-slate-200 cursor-pointer p-1"
              tabIndex={-1}
            >
              {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          <div className="flex items-center justify-between pt-1">
            <span className="text-[10px] text-slate-400 italic">
              Encrypted directly into Infisical vault; never stored in chat logs.
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onDismiss(request.id)}
                disabled={isPending}
                className="px-2.5 py-1 rounded bg-[var(--bark-800,#1b2620)] hover:bg-[var(--bark-700,#24332b)] text-slate-300 text-xs transition-colors disabled:opacity-50 cursor-pointer"
              >
                Dismiss
              </button>
              <button
                type="button"
                onClick={() => {
                  if (value.trim()) {
                    onSubmit(request.id, value.trim());
                  }
                }}
                disabled={isPending || !value.trim()}
                className="px-3 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold transition-colors disabled:opacity-50 cursor-pointer flex items-center gap-1.5"
              >
                <Lock size={12} />
                <span>Save to Vault</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}