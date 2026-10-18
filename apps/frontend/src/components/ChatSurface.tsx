import { Fragment, useState, useRef, useEffect, useCallback, useMemo, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, AlertTriangle, X } from 'lucide-react';
import CollapsibleHistoryList from './CollapsibleHistoryList.js';
import AgentConfigDrawer from './AgentConfigDrawer.js';
import ModelConfigDrawer from './ModelConfigDrawer.js';
import { useMachineChoiceLabel } from '../api/local-agents';
import KoalaLoading from './KoalaLoading.js';
import ChatHero from './Chat/ChatHero.js';
import { ConversationContext } from './Chat/ConversationContext.js';
import ChatComposer, { type PersonaPackOption } from './Chat/ChatComposer.js';
import ChatMessageRow from './Chat/ChatMessageRow.js';
import ChatNotice, { type StoryAddress } from './Chat/ChatNotice.js';
import DocumentPanel from './DocumentPanel.js';
import type { FileArtifact } from './Chat/ChatToolCallCard.js';
import { listAgents, agentKeys, type Agent } from '../api/agents';
import { listModels, providerKeys, useDefaultModel, type ModelProvider } from '../api/models';
import { chatPackKeys, type ConversationBinding } from '../api/chat-pack.js';
import { postChannelMessage } from '../api/project-channel.js';
import { addressOf, channelAsksKoala, goesToKoala, rememberChannelAsks } from '../lib/channel-asks.js';
import { errorMessage } from '../api/client.js';
import { modelOptionLabel } from '../lib/model-label';
import { type ChatMessageRecord } from './Chat/chat-stream.js';
import { useChatScroll } from './Chat/hooks/useChatScroll.js';
import { useConversationTurn } from './Chat/hooks/useConversationTurn.js';
import ChatApprovalCard from './Chat/ChatApprovalCard.js';
import PlanProposalCard from './Chat/PlanProposalCard.js';
import { usePlanProposals } from './Chat/hooks/usePlanProposals.js';
import SecretRequestCard from './Chat/SecretRequestCard.js';
import { useSecretRequests } from './Chat/hooks/useSecretRequests.js';
import { listConversationSecretRequests, secretRequestKeys } from '../api/secret-requests.js';
import McpRequestCard from './Chat/McpRequestCard.js';
import McpServersMenu from './Chat/McpServersMenu.js';
import { useConversationMcp, useMcpServers } from './Chat/hooks/useMcp.js';
import ActionProposalCard from './Chat/ActionProposalCard.js';
import { useActionProposals } from './Chat/hooks/useActionProposals.js';
import { actionKeys, listConversationActions } from '../api/actions.js';
import EgressRequestCard from './Chat/EgressRequestCard.js';
import { useEgressRequests } from './Chat/hooks/useEgressRequests.js';
import { egressKeys, listEgressRequests } from '../api/egress.js';
import AccessRequestCard from './Chat/AccessRequestCard.js';
import { useAccessRequests } from './Chat/hooks/useAccessRequests.js';
import { ChatHeader } from './Chat/ChatHeader.js';
import { ChatCardMarker, ChatCards, type CardFocus } from './Chat/ChatCards.js';
import { cardMarkers, chatCards, isWaiting, type ChatCard } from './Chat/chat-cards.js';
import { useCardsLayout } from './Chat/hooks/useCardsLayout.js';

export type { ChatMessageRecord };

export interface ChatSurfaceProps {
  conversationId?: string | undefined;
  sessionId?: string | undefined;
  modelId?: string | undefined;
  initialMessages?: ChatMessageRecord[] | undefined;
  hideSidebar?: boolean | undefined;
  channel?: boolean | undefined;
  pinned?: boolean | undefined;
  intro?: ReactNode | undefined;
  onConversationChange?: ((conversationId: string | null) => void) | undefined;
  onOpenTree?: ((treeId: string) => void) | undefined;
  onOpenStory?: ((story: StoryAddress) => void) | undefined;
  binding?: ConversationBinding | undefined;
  autoSend?: { text: string; onSent?: (() => void) | undefined } | undefined;
}

export default function ChatSurface({
  conversationId: externalConvId,
  sessionId: externalSessionId,
  modelId,
  initialMessages = [],
  hideSidebar = false,
  channel = false,
  pinned = false,
  intro,
  onConversationChange,
  onOpenTree,
  onOpenStory,
  binding,
  autoSend,
}: ChatSurfaceProps) {
  const [showHistory, setShowHistory] = useState(false);
  const [showPersonaDrawer, setShowPersonaDrawer] = useState(false);
  const [showModelDrawer, setShowModelDrawer] = useState(false);
  const [openDocument, setOpenDocument] = useState<FileArtifact | undefined>(undefined);
  const showDocument = useCallback((file: FileArtifact) => setOpenDocument(file), []);

  const qc = useQueryClient();
  const conv = useConversationTurn({
    externalConvId,
    externalSessionId,
    modelId,
    initialMessages,
    enabled: true,
    onConversationChange,
    binding,
  });

  const { streaming, error, setError } = conv;
  const planProposals = usePlanProposals(conv.selectedConvId, streaming);
  const secretRequests = useSecretRequests(
    secretRequestKeys.forConversation(conv.selectedConvId ?? ''),
    () => listConversationSecretRequests(conv.selectedConvId!),
    Boolean(conv.selectedConvId),
    streaming,
  );
  const mcp = useConversationMcp(conv.selectedConvId, streaming);
  const { data: mcpServers = [] } = useMcpServers();
  const access = useAccessRequests(conv.selectedConvId, streaming);
  const egress = useEgressRequests(
    egressKeys.requests('conversation', conv.selectedConvId ?? ''),
    () => listEgressRequests('conversationId', conv.selectedConvId!),
    Boolean(conv.selectedConvId),
    streaming,
  );
  const actions = useActionProposals(
    actionKeys.forConversation(conv.selectedConvId ?? ''),
    () => listConversationActions(conv.selectedConvId!),
    Boolean(conv.selectedConvId),
    streaming,
  );

  const { data: agents = [] } = useQuery<Agent[]>({
    queryKey: agentKeys.all,
    queryFn: listAgents,
  });

  const { data: defaultSetting } = useDefaultModel();
  const accountDefaultId = defaultSetting?.defaultModelId ?? null;

  const { data: models = [] } = useQuery<ModelProvider[]>({
    queryKey: providerKeys.list(),
    queryFn: listModels,
    staleTime: 5 * 60_000,
  });

  const renderedMessages = conv.renderedMessages;

  const {
    scrollRef,
    bottomAnchorRef,
    isAtBottom,
    setIsAtBottom,
    scrollToBottom,
    scrollToBottomInstant,
    handleFeedScroll,
  } = useChatScroll({
    dependencies: [
      conv.activeConversation?.messages,
      conv.localMessages,
      conv.liveState.live,
      conv.liveState.liveThinking,
      conv.liveState.tools,
      streaming,
    ],
  });

  const machineLabel = useMachineChoiceLabel(conv.pinnedModelId);
  const selectedAgent = agents.find((a) => a.slug === conv.selectedAgentSlug);
  const activePack: PersonaPackOption | undefined = selectedAgent
    ? { id: selectedAgent.slug, name: selectedAgent.name, label: selectedAgent.name.toUpperCase(), desc: selectedAgent.description ?? '' }
    : undefined;

  const effectiveModel = models.find((m) => m.id === (conv.pinnedModelId ?? accountDefaultId));
  const modelLabel = machineLabel ?? (effectiveModel
    ? modelOptionLabel(effectiveModel)
    : conv.pinnedModelId ?? 'No model');

  const toolCount = selectedAgent?.tools.length;
  const openPersonaDrawer = () => setShowPersonaDrawer(true);

  const isLoadingThread = conv.loadingConversation && renderedMessages.length === 0 && !streaming;
  const isConversationEmpty = renderedMessages.length === 0 && !streaming && !isLoadingThread;

  const [askingKoala, setAskingKoala] = useState(() => Boolean(channel && externalConvId && channelAsksKoala(externalConvId)));
  const toggleAskingKoala = () => {
    const next = !askingKoala;
    setAskingKoala(next);
    if (conv.selectedConvId) rememberChannelAsks(conv.selectedConvId, next);
  };
  const localFrom = renderedMessages.length - conv.localMessages.length;

  const rowRef = useRef<HTMLDivElement>(null);
  const cardsLayout = useCardsLayout(rowRef);
  const [cardsTab, setCardsTab] = useState<'chat' | 'cards'>('chat');
  const [cardFocus, setCardFocus] = useState<CardFocus | undefined>(undefined);
  const cards = useMemo(() => chatCards({
    plans: planProposals.plans,
    actions: actions.proposals,
    secrets: secretRequests.requests,
    mcp: mcp.requests,
    egress: egress.requests,
    access: access.requests,
    approval: conv.pendingApproval,
  }), [planProposals.plans, actions.proposals, secretRequests.requests, mcp.requests, egress.requests, access.requests, conv.pendingApproval]);
  const cardsAt = useMemo(() => cardMarkers(renderedMessages, cards), [renderedMessages, cards]);
  const waitingCards = cards.filter(isWaiting).length;
  const showing = cardsLayout === 'tab' && cards.length > 0 ? cardsTab : 'chat';
  const showCard = (id: string) => {
    setCardsTab('cards');
    setCardFocus((was) => ({ id, n: (was?.n ?? 0) + 1 }));
  };

  const renderCard = (card: ChatCard): ReactNode => {
    switch (card.kind) {
      case 'plan':
        return (
          <PlanProposalCard
            proposal={card.item}
            deciding={planProposals.deciding}
            onApprove={() => planProposals.approve(card.id)}
            onReject={(reason) => planProposals.reject(card.id, reason)}
            onOpenTree={onOpenTree}
            onOpenStory={onOpenStory}
          />
        );
      case 'access':
        return <AccessRequestCard request={card.item} busy={access.busy} error={access.error} onGrant={() => access.grant(card.id)} onDismiss={() => access.dismiss(card.id)} />;
      case 'egress':
        return <EgressRequestCard request={card.item} busy={egress.busy} error={egress.error} onAllow={() => egress.allow(card.id)} onDismiss={() => egress.dismiss(card.id)} />;
      case 'action':
        return <ActionProposalCard proposal={card.item} busy={actions.busy} error={actions.error} onApply={() => actions.apply(card.id)} onReject={() => actions.reject(card.id)} />;
      case 'mcp':
        return <McpRequestCard request={card.item} busy={mcp.busy} error={mcp.error} onEnable={() => mcp.enable(card.id)} onDismiss={() => mcp.dismiss(card.id)} />;
      case 'secret':
        return (
          <SecretRequestCard
            request={card.item}
            busy={secretRequests.busy}
            error={secretRequests.error}
            onSubmit={(value, done) => secretRequests.submit(card.id, value, done)}
            onDismiss={() => secretRequests.dismiss(card.id)}
          />
        );
      case 'approval':
        return conv.pendingApproval ? (
          <ChatApprovalCard
            reason={conv.pendingApproval.reason}
            {...(conv.pendingApproval.toolName ? { toolName: conv.pendingApproval.toolName, args: conv.pendingApproval.args } : {})}
            onDecide={(decision) => void conv.decideApproval(decision)}
          />
        ) : null;
    }
  };
  const askKoalaAbout = (message: ChatMessageRecord) => {
    if (streaming || !message.at) return;
    setError(null);
    setIsAtBottom(true);
    requestAnimationFrame(scrollToBottomInstant);
    void conv.sendConversationTurn(message.content, { asks: message.at });
  };

  const handleSend = (rawText: string) => {
    const text = rawText.trim();
    if (!text || streaming) return;

    setError(null);
    setIsAtBottom(true);
    requestAnimationFrame(scrollToBottomInstant);
    if (channel && conv.selectedConvId && !goesToKoala(text, askingKoala)) {
      const id = conv.selectedConvId;
      void postChannelMessage(id, text)
        .then(() => qc.invalidateQueries({ queryKey: chatPackKeys.conversation(id) }))
        .catch((err: unknown) => setError(errorMessage(err)));
      return;
    }
    void conv.sendConversationTurn(text);
  };

  const autoSentRef = useRef<string | null>(null);
  useEffect(() => {
    if (!autoSend || streaming || !conv.selectedConvId) return;
    const key = `${conv.selectedConvId}:${autoSend.text}`;
    if (autoSentRef.current === key) return;
    autoSentRef.current = key;
    handleSend(autoSend.text);
    autoSend.onSent?.();
  }, [autoSend, conv.selectedConvId, streaming, handleSend]);

  const handleStop = () => conv.handleStop();

  const composer = (
    <ChatComposer
      onSend={handleSend}
      onStop={handleStop}
      isStreaming={streaming}
      {...(activePack ? { activePack } : {})}
      onOpenPersonaDrawer={openPersonaDrawer}
      {...(toolCount !== undefined ? { toolCount } : {})}
      modelLabel={modelLabel}
      onOpenModelDrawer={() => setShowModelDrawer(true)}
      {...(channel ? {
        placeholder: askingKoala ? 'Ask Koala — it answers in the channel' : 'Post to the channel — start with @koala to ask Koala',
        channelAsk: { on: askingKoala, onToggle: toggleAskingKoala },
      } : {})}
    />
  );

  return (
    <div className="flex flex-col h-full min-h-0 w-full bg-[var(--bark-950,#090d0b)] text-slate-200 font-sans overflow-hidden">
      {(!(channel || pinned) || mcpServers.length > 0) && (
      <ChatHeader
        hideSidebar={hideSidebar}
        showHistory={showHistory}
        onToggleHistory={() => setShowHistory(!showHistory)}
        selectedConvId={conv.selectedConvId}
        activeConversation={conv.activeConversation}
        conversations={conv.conversations}
        {...(channel || pinned ? {} : {
          onSelectConversation: (id: string) => {
            conv.setSelectedConvId(id);
            onConversationChange?.(id);
          },
        })}
        {...(channel || pinned ? {} : { onNewChat: () => conv.createMutation.mutate() })}
        isCreatingChat={conv.createMutation.isPending}
        actions={conv.selectedConvId ? (
          <McpServersMenu
            servers={mcpServers}
            enabled={conv.activeConversation?.mcpServers ?? []}
            busy={mcp.busy}
            onChoose={mcp.choose}
          />
        ) : undefined}
      />
      )}

      {cardsLayout === 'tab' && cards.length > 0 && (
        <div role="tablist" className="flex gap-1 px-3 pt-2 border-b border-[var(--bark-800,#1b2620)] bg-[var(--bark-950,#090d0b)]">
          {(['chat', 'cards'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={showing === tab}
              onClick={() => setCardsTab(tab)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-[12px] border-b-2 -mb-px cursor-pointer ${showing === tab ? 'border-emerald-500 text-slate-100' : 'border-transparent text-slate-400 hover:text-slate-200'}`}
            >
              {tab === 'chat' ? 'Chat' : 'Cards'}
              {tab === 'cards' && waitingCards > 0 && (
                <span className="rounded-full bg-amber-500/20 text-amber-200 px-1.5 text-[10px]" aria-label={`${waitingCards} waiting for you`}>{waitingCards}</span>
              )}
            </button>
          ))}
        </div>
      )}

      <div ref={rowRef} className="flex-1 min-h-0 flex flex-col sm:flex-row overflow-hidden relative">
        {!hideSidebar && (
          <CollapsibleHistoryList
            conversations={conv.conversations}
            activeId={conv.selectedConvId ?? undefined}
            isOpen={showHistory}
            onToggle={() => setShowHistory(false)}
            onSelect={(id) => {
              conv.setSelectedConvId(id);
              onConversationChange?.(id);
            }}
            onNewChat={() => conv.createMutation.mutate()}
            onDelete={(id) => conv.deleteMutation.mutate(id)}
          />
        )}

        {showing === 'cards' && (
          <div className="flex-1 min-h-0 bg-[var(--bark-950,#090d0b)]">
            <ChatCards cards={cards} focus={cardFocus} render={renderCard} />
          </div>
        )}

        <div className={`flex-1 flex flex-col h-full min-h-0 overflow-hidden bg-[var(--bark-950,#090d0b)] relative ${showing === 'cards' ? 'hidden' : ''}`}>
          {isConversationEmpty ? (
            <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 flex flex-col justify-center items-center">
              <div className="w-full max-w-3xl space-y-6">
                {intro ? (
                  <div className="text-center space-y-2 text-slate-400" data-testid="chat-intro">{intro}</div>
                ) : channel ? (
                  <div className="text-center space-y-2 text-slate-400" data-testid="channel-empty">
                    <p className="text-[14px] text-slate-200">This is the project&apos;s channel.</p>
                    <p className="text-[12px]">What happens to the project lands here: previews to look at, releases, trees that finish. Write here to post a note for the project; start with @koala, or turn on Ask Koala below, to ask Koala.</p>
                  </div>
                ) : (
                  <ChatHero
                    packName={activePack?.name ?? 'Koala'}
                    onSelectPrompt={(p) => handleSend(p)}
                    onOpenPersona={openPersonaDrawer}
                  />
                )}
                {conv.selectedConvId && <ConversationContext conversationId={conv.selectedConvId} channel={channel} />}
                {composer}
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

                  {conv.selectedConvId && <ConversationContext conversationId={conv.selectedConvId} channel={channel} />}

                  {renderedMessages.length > 0 && (cardsAt.get(-1) ?? []).map((card) => <ChatCardMarker key={`${card.kind} ${card.id}`} card={card} onShow={showCard} />)}

                  {renderedMessages.map((msg, idx) => (
                    <Fragment key={idx}>
                      {msg.role === 'notice' && msg.notice
                        ? <ChatNotice notice={msg.notice} at={msg.at} onOpenTree={onOpenTree} onOpenStory={onOpenStory} />
                        : (
                          <ChatMessageRow
                            message={msg}
                            packLabel={activePack?.label ?? ''}
                            onOpenDocument={showDocument}
                            {...(channel ? {
                              address: addressOf(msg, idx >= localFrom),
                              ...(!streaming && msg.at && !msg.runId && idx < localFrom ? { onAskKoala: () => askKoalaAbout(msg) } : {}),
                            } : {})}
                          />
                        )}
                      {idx < renderedMessages.length - 1 && (cardsAt.get(idx) ?? []).map((card) => <ChatCardMarker key={`${card.kind} ${card.id}`} card={card} onShow={showCard} />)}
                    </Fragment>
                  ))}

                  {streaming && (
                    <ChatMessageRow
                      message={{
                        role: 'assistant',
                        content: conv.liveState.live,
                        reasoning: conv.liveState.liveThinking,
                        toolCalls: conv.liveState.tools,
                      }}
                      packLabel={activePack?.label ?? ''}
                      isStreaming={true}
                      onOpenDocument={showDocument}
                    />
                  )}

                  {(cardsAt.get(renderedMessages.length - 1) ?? []).map((card) => <ChatCardMarker key={`${card.kind} ${card.id}`} card={card} onShow={showCard} />)}

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
                  {composer}
                </div>
              </div>
            </>
          )}
        </div>

        {cardsLayout === 'column' && cards.length > 0 && (
          <aside className="w-[22rem] xl:w-[26rem] shrink-0 flex flex-col min-h-0 border-l border-[var(--bark-800,#1b2620)] bg-[var(--bark-950,#090d0b)]" aria-label="Cards">
            <header className="flex items-center justify-between px-4 py-2 border-b border-[var(--bark-800,#1b2620)] text-[12px] text-slate-300">
              <span>Cards</span>
              {waitingCards > 0 && <span className="text-amber-200">{waitingCards} waiting for you</span>}
            </header>
            <div className="flex-1 min-h-0">
              <ChatCards cards={cards} focus={cardFocus} render={renderCard} />
            </div>
          </aside>
        )}
      </div>

      <ModelConfigDrawer
        isOpen={showModelDrawer}
        onClose={() => setShowModelDrawer(false)}
        selectedModelId={conv.pinnedModelId}
        onSelectModel={conv.setPinnedModelId}
        reach={conv.modelReach}
        onReach={conv.setModelReach}
      />

      <AgentConfigDrawer
        isOpen={showPersonaDrawer}
        onClose={() => setShowPersonaDrawer(false)}
        selectedAgentSlug={conv.selectedAgentSlug}
        onSelectAgent={conv.setSelectedAgentSlug}
      />

      {openDocument && <DocumentPanel file={openDocument} onClose={() => setOpenDocument(undefined)} />}
    </div>
  );
}
