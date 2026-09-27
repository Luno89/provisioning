import { useState, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, AlertTriangle, X } from 'lucide-react';
import CollapsibleHistoryList from './CollapsibleHistoryList.js';
import AgentConfigDrawer from './AgentConfigDrawer.js';
import ModelConfigDrawer from './ModelConfigDrawer.js';
import KoalaLoading from './KoalaLoading.js';
import ChatHero from './Chat/ChatHero.js';
import ChatComposer, { type PersonaPackOption } from './Chat/ChatComposer.js';
import ChatMessageRow from './Chat/ChatMessageRow.js';
import { listAgents, agentKeys, type Agent } from '../api/agents';
import { listModels, providerKeys, useDefaultModel, type ModelProvider } from '../api/models';
import type { ConversationBinding } from '../api/chat-pack.js';
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
import { ChatHeader } from './Chat/ChatHeader.js';

export type { ChatMessageRecord };

export interface ChatSurfaceProps {
  conversationId?: string | undefined;
  sessionId?: string | undefined;
  modelId?: string | undefined;
  initialMessages?: ChatMessageRecord[] | undefined;
  hideSidebar?: boolean | undefined;
  onConversationChange?: ((conversationId: string | null) => void) | undefined;
  onOpenTree?: ((treeId: string) => void) | undefined;
  binding?: ConversationBinding | undefined;
  autoSend?: { text: string; onSent?: (() => void) | undefined } | undefined;
}

export default function ChatSurface({
  conversationId: externalConvId,
  sessionId: externalSessionId,
  modelId,
  initialMessages = [],
  hideSidebar = false,
  onConversationChange,
  onOpenTree,
  binding,
  autoSend,
}: ChatSurfaceProps) {
  const [showHistory, setShowHistory] = useState(false);
  const [showPersonaDrawer, setShowPersonaDrawer] = useState(false);
  const [showModelDrawer, setShowModelDrawer] = useState(false);

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

  const selectedAgent = agents.find((a) => a.slug === conv.selectedAgentSlug);
  const activePack: PersonaPackOption | undefined = selectedAgent
    ? { id: selectedAgent.slug, name: selectedAgent.name, label: selectedAgent.name.toUpperCase(), desc: selectedAgent.description ?? '' }
    : undefined;

  const effectiveModel = models.find((m) => m.id === (conv.pinnedModelId ?? accountDefaultId));
  const modelLabel = effectiveModel
    ? modelOptionLabel(effectiveModel)
    : conv.pinnedModelId ?? 'No model';

  const toolCount = selectedAgent?.tools.length;
  const openPersonaDrawer = () => setShowPersonaDrawer(true);

  const isLoadingThread = conv.loadingConversation && renderedMessages.length === 0 && !streaming;
  const isConversationEmpty = renderedMessages.length === 0 && !streaming && !isLoadingThread;

  const handleSend = (rawText: string) => {
    const text = rawText.trim();
    if (!text || streaming) return;

    setError(null);
    setIsAtBottom(true);
    requestAnimationFrame(scrollToBottomInstant);
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
    />
  );

  return (
    <div className="flex flex-col h-full min-h-0 w-full bg-[var(--bark-950,#090d0b)] text-slate-200 font-sans overflow-hidden">
      <ChatHeader
        hideSidebar={hideSidebar}
        showHistory={showHistory}
        onToggleHistory={() => setShowHistory(!showHistory)}
        selectedConvId={conv.selectedConvId}
        activeConversation={conv.activeConversation}
        conversations={conv.conversations}
        onSelectConversation={(id) => {
          conv.setSelectedConvId(id);
          onConversationChange?.(id);
        }}
        onNewChat={() => conv.createMutation.mutate()}
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

      <div className="flex-1 min-h-0 flex flex-col sm:flex-row overflow-hidden relative">
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

        <div className="flex-1 flex flex-col h-full min-h-0 overflow-hidden bg-[var(--bark-950,#090d0b)] relative">
          {isConversationEmpty ? (
            <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 flex flex-col justify-center items-center">
              <div className="w-full max-w-3xl space-y-6">
                <ChatHero
                  packName={activePack?.name ?? 'Koala'}
                  onSelectPrompt={(p) => handleSend(p)}
                  onOpenPersona={openPersonaDrawer}
                />
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

                  {renderedMessages.map((msg, idx) => (
                    <ChatMessageRow
                      key={idx}
                      message={msg}
                      packLabel={activePack?.label ?? ''}
                    />
                  ))}

                  {planProposals.plans.map((proposal) => (
                    <PlanProposalCard
                      key={proposal.id}
                      proposal={proposal}
                      deciding={planProposals.deciding}
                      onApprove={() => planProposals.approve(proposal.id)}
                      onReject={(reason) => planProposals.reject(proposal.id, reason)}
                      onOpenTree={onOpenTree}
                    />
                  ))}

                  {actions.proposals.map((proposal) => (
                    <ActionProposalCard
                      key={proposal.id}
                      proposal={proposal}
                      busy={actions.busy}
                      error={actions.error}
                      onApply={() => actions.apply(proposal.id)}
                      onReject={() => actions.reject(proposal.id)}
                    />
                  ))}

                  {mcp.requests.map((request) => (
                    <McpRequestCard
                      key={request.id}
                      request={request}
                      busy={mcp.busy}
                      error={mcp.error}
                      onEnable={() => mcp.enable(request.id)}
                      onDismiss={() => mcp.dismiss(request.id)}
                    />
                  ))}

                  {secretRequests.requests.map((request) => (
                    <SecretRequestCard
                      key={request.id}
                      request={request}
                      busy={secretRequests.busy}
                      error={secretRequests.error}
                      onSubmit={(value, done) => secretRequests.submit(request.id, value, done)}
                      onDismiss={() => secretRequests.dismiss(request.id)}
                    />
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
                    />
                  )}

                  {conv.pendingApproval && (
                    <ChatApprovalCard
                      reason={conv.pendingApproval.reason}
                      {...(conv.pendingApproval.toolName ? { toolName: conv.pendingApproval.toolName, args: conv.pendingApproval.args } : {})}
                      onAllow={() => void conv.decideApproval(true)}
                      onDeny={() => void conv.decideApproval(false)}
                    />
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
                  {composer}
                </div>
              </div>
            </>
          )}
        </div>

      </div>

      <ModelConfigDrawer
        isOpen={showModelDrawer}
        onClose={() => setShowModelDrawer(false)}
        selectedModelId={conv.pinnedModelId}
        onSelectModel={conv.setPinnedModelId}
      />

      <AgentConfigDrawer
        isOpen={showPersonaDrawer}
        onClose={() => setShowPersonaDrawer(false)}
        selectedAgentSlug={conv.selectedAgentSlug}
        onSelectAgent={conv.setSelectedAgentSlug}
      />
    </div>
  );
}
