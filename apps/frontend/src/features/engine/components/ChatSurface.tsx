import { Fragment, useState, useRef, useCallback, useMemo, type ReactNode } from 'react';
import { ArrowDown, AlertTriangle, X } from 'lucide-react';
import CollapsibleHistoryList from './CollapsibleHistoryList.js';
import AgentConfigDrawer from './AgentConfigDrawer.js';
import { ModelConfigDrawer } from '../../models';
import KoalaLoading from '../../../shared/components/KoalaLoading.js';
import ChatHero from './Chat/ChatHero.js';
import { ConversationContext } from './Chat/ConversationContext.js';
import ChatComposer from './Chat/ChatComposer.js';
import ChatMessageRow from './Chat/ChatMessageRow.js';
import { noticeRepeats } from './Chat/notice-repeats.js';
import ChatNotice, { type StoryAddress } from './Chat/ChatNotice.js';
import DocumentPanel from './DocumentPanel.js';
import type { FileArtifact } from './Chat/ChatToolCallCard.js';
import { type ConversationBinding } from '../api/chat-pack.js';
import { addressOf } from '../../projects';
import { type ChatMessageRecord } from './Chat/chat-stream.js';
import { useChatScroll } from '../hooks/useChatScroll.js';
import { useConversationTurn } from '../hooks/useConversationTurn.js';
import McpServersMenu from './Chat/McpServersMenu.js';
import { useMcpServers } from '../hooks/useMcp.js';
import { ChatHeader } from './Chat/ChatHeader.js';
import { ChatCardMarker, ChatCards, type CardFocus } from './Chat/ChatCards.js';
import { ChatCardBody } from './Chat/ChatCardBody.js';
import { cardMarkers, isWaiting, type ChatCard } from './Chat/chat-cards.js';
import { useCardsLayout } from '../hooks/useCardsLayout.js';
import { useChatCards } from '../hooks/useChatCards.js';
import { useChatComposer } from '../hooks/useChatComposer.js';
import { channelPlaceholder } from '../lib/chat-composer';

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
  const from = useChatCards(conv.selectedConvId, streaming, conv.pendingApprovals);
  const { mcp, cards } = from;
  const { data: mcpServers = [] } = useMcpServers();

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

  const composerState = useChatComposer({
    conv,
    binding,
    channel,
    externalConvId,
    autoSend,
    jumpToLatest: () => {
      setIsAtBottom(true);
      requestAnimationFrame(scrollToBottomInstant);
    },
  });
  const { activePack, modelLabel, toolCount, askingKoala, toggleAskingKoala, askKoalaAbout, handleSend, autoMode, switchAutoMode } = composerState;
  const chatAttachments = composerState.attachments;
  const openPersonaDrawer = () => setShowPersonaDrawer(true);

  const isLoadingThread = conv.loadingConversation && renderedMessages.length === 0 && !streaming;
  const isConversationEmpty = renderedMessages.length === 0 && !streaming && !isLoadingThread;

  const localFrom = renderedMessages.length - conv.localMessages.length;

  const rowRef = useRef<HTMLDivElement>(null);
  const cardsLayout = useCardsLayout(rowRef);
  const [cardsTab, setCardsTab] = useState<'chat' | 'cards'>('chat');
  const [cardFocus, setCardFocus] = useState<CardFocus | undefined>(undefined);
  const repeats = useMemo(() => noticeRepeats(renderedMessages), [renderedMessages]);
  const cardsAt = useMemo(() => cardMarkers(renderedMessages, cards), [renderedMessages, cards]);
  const waitingCards = cards.filter(isWaiting).length;
  const showing = cardsLayout === 'tab' && cards.length > 0 ? cardsTab : 'chat';
  const showCard = (id: string) => {
    setCardsTab('cards');
    setCardFocus((was) => ({ id, n: (was?.n ?? 0) + 1 }));
  };

  const renderCard = (card: ChatCard): ReactNode => (
    <ChatCardBody
      card={card}
      from={from}
      onOpenTree={onOpenTree}
      onOpenStory={onOpenStory}
      onApproval={(approval, decision) => void (decision === 'auto-chat' ? switchAutoMode(true) : conv.decideApproval(approval, decision))}
    />
  );

  const handleStop = () => conv.handleStop();

  const composer = (
    <ChatComposer
      onSend={handleSend}
      attachments={chatAttachments.attached}
      onRemoveAttachment={chatAttachments.remove}
      onAttach={chatAttachments.attach}
      onStop={handleStop}
      isStreaming={streaming}
      {...(activePack ? { activePack } : {})}
      onOpenPersonaDrawer={openPersonaDrawer}
      {...(toolCount !== undefined ? { toolCount } : {})}
      modelLabel={modelLabel}
      onOpenModelDrawer={() => setShowModelDrawer(true)}
      {...(conv.selectedConvId && autoMode.on !== undefined ? { autoMode: { on: autoMode.on, switching: autoMode.switching, onToggle: () => void switchAutoMode(!autoMode.on) } } : {})}
      {...(channel ? {
        placeholder: channelPlaceholder(askingKoala),
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
                        ? (repeats.get(idx) ?? 1) > 0 && <ChatNotice notice={msg.notice} at={msg.at} onOpenTree={onOpenTree} onOpenStory={onOpenStory} times={repeats.get(idx) ?? 1} onItsPage={Boolean(channel)} />
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
