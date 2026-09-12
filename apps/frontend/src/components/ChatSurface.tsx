import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, AlertTriangle, X, Square } from 'lucide-react';
import CollapsibleHistoryList from './CollapsibleHistoryList.js';
import ProposalsSidebar from './ProposalsSidebar.js';
import PersonaConfigDrawer from './PersonaConfigDrawer.js';
import ModelConfigDrawer from './ModelConfigDrawer.js';
import KoalaLoading from './KoalaLoading.js';
import ChatHero from './Chat/ChatHero.js';
import ChatComposer, { type PersonaPackOption } from './Chat/ChatComposer.js';
import ChatMessageRow from './Chat/ChatMessageRow.js';
import { listPacks, packKeys, type PersonaPack } from '../api/packs';
import { listTrees, listTreeTypes, updateTreeType, groveKeys } from '../api/grove';
import { listModels, providerKeys, useDefaultModel, type ModelProvider } from '../api/models';
import { modelOptionLabel } from '../lib/model-label';
import { useShellStore } from '../stores/shell.js';
import { errorMessage } from '../api/client.js';

// Extracted modules
import { type ChatMessageRecord } from './Chat/chat-stream.js';
import { useChatScroll } from './Chat/hooks/useChatScroll.js';
import { useConversationTurn } from './Chat/hooks/useConversationTurn.js';
import {
  useBranchTurn,
  type ChatMode,
  type ProposedLeaf,
  type ChatAttachment,
  type ChatScope,
} from './Chat/hooks/useBranchTurn.js';
import { useChatProposals } from './Chat/hooks/useChatProposals.js';
import { ChatHeader, MODE_HINT } from './Chat/ChatHeader.js';
import { SproutingLeavesCard } from './Chat/SproutingLeavesCard.js';

export type { ChatMessageRecord, ChatMode, ProposedLeaf, ChatAttachment, ChatScope };
export { MODE_HINT };

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
  const setShellView = useShellStore((s) => s.setView);
  const isBranch = scope?.kind === 'branch';
  const branch = isBranch ? scope : undefined;

  const [showHistory, setShowHistory] = useState(false);
  const [showProposals, setShowProposals] = useState(false);
  const [showPersonaDrawer, setShowPersonaDrawer] = useState(false);
  const [showModelDrawer, setShowModelDrawer] = useState(false);
  const [branchModelId, setBranchModelId] = useState<string | null>(null);
  const [branchError, setBranchError] = useState<string | null>(null);

  // 1. Conversation lifecycle hook (for Koala chat)
  const conv = useConversationTurn({
    externalConvId,
    externalSessionId,
    modelId,
    initialMessages,
    enabled: !isBranch,
    onConversationChange,
    onProposedTree: () => setShowProposals(true),
  });

  // 2. Branch lifecycle hook (for workspace branch chat)
  const branchTurn = useBranchTurn({
    branch,
    branchModelId,
    onError: setBranchError,
  });

  const streaming = isBranch ? branchTurn.streaming : conv.streaming;
  const overthinkWarning = isBranch ? branchTurn.overthinkWarning : conv.overthinkWarning;
  const error = isBranch ? branchError : conv.error;
  const setError = isBranch ? setBranchError : conv.setError;

  // 3. Proposals and mutations hook
  const proposals = useChatProposals({
    activeConversation: conv.activeConversation,
    liveState: conv.liveState,
    onOpenTree,
    onError: setError,
  });

  // 4. Queries for metadata (packs, trees, treeTypes, models)
  const { data: packs = [] } = useQuery<PersonaPack[]>({
    queryKey: packKeys.list(),
    queryFn: listPacks,
  });

  const { data: trees = [] } = useQuery({
    queryKey: groveKeys.trees(),
    queryFn: listTrees,
    enabled: isBranch,
  });
  const qc = useQueryClient();
  const [selectedBranchPackSlug, setSelectedBranchPackSlug] = useState<string | null>(null);

  const { data: treeTypes = [] } = useQuery({
    queryKey: groveKeys.treeTypes(),
    queryFn: listTreeTypes,
    enabled: isBranch,
  });
  const branchTree = isBranch ? trees.find((t) => t.id === branch?.treeId) : undefined;
  const branchTreeType = branchTree ? treeTypes.find((t: any) => t.id === branchTree.type) : undefined;
  const plannerPackId = (branchTreeType as any)?.packs?.planner as string | undefined;
  const effectivePlannerPackSlug = selectedBranchPackSlug ?? plannerPackId;
  const plannerPack = effectivePlannerPackSlug
    ? packs.find((p) => p.id === effectivePlannerPackSlug || p.slug === effectivePlannerPackSlug)
    : undefined;

  const setBranchPlannerPackMutation = useMutation({
    mutationFn: async (packId: string) => {
      if (!isBranch) return;
      const targetTree = branchTree ?? trees.find((t) => t.id === branch?.treeId);
      const targetType = branchTreeType ?? treeTypes.find((t: any) => t.id === targetTree?.type);
      if (!targetType) return;
      const pack = packs.find((p) => p.id === packId || p.slug === packId);
      const slug = pack?.slug ?? packId;
      setSelectedBranchPackSlug(slug);
      return updateTreeType(targetType.id, {
        ...targetType,
        packs: {
          ...(targetType.packs ?? {}),
          planner: slug,
        },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: groveKeys.treeTypes() });
    },
    onError: (err) => {
      setError(`Could not set persona pack: ${errorMessage(err)}`);
    },
  });

  const { data: defaultSetting } = useDefaultModel();
  const accountDefaultId = defaultSetting?.defaultModelId ?? null;

  const activeModelId = isBranch ? branchModelId : conv.pinnedModelId;
  const setActiveModelId = isBranch ? setBranchModelId : conv.setPinnedModelId;

  const { data: models = [] } = useQuery<ModelProvider[]>({
    queryKey: providerKeys.list(),
    queryFn: listModels,
    staleTime: 5 * 60_000,
  });

  const renderedMessages = useMemo(() => {
    if (branch) return branch.messages;
    return conv.renderedMessages;
  }, [branch, conv.renderedMessages]);

  // 5. Scroll observation and management hook
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
      branch?.messages,
      conv.liveState.live,
      conv.liveState.liveThinking,
      conv.liveState.tools,
      branchTurn.liveState.live,
      branchTurn.liveState.liveThinking,
      branchTurn.liveState.tools,
      streaming,
    ],
  });

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
  const activePack: PersonaPackOption | undefined = isBranch
    ? (plannerPack
      ? { id: plannerPack.id, name: plannerPack.name, label: plannerPack.name.toUpperCase(), desc: plannerPack.description ?? '' }
      : undefined)
    : personaPacks.find((p) => p.id === koalaPackId);

  const effectiveModel = models.find((m) => m.id === (activeModelId ?? accountDefaultId));
  const modelLabel = effectiveModel
    ? modelOptionLabel(effectiveModel)
    : activeModelId ?? 'No model';

  const currentPackRecord = activePack ? packs.find((p) => p.id === activePack.id) : undefined;
  const toolCount = currentPackRecord?.tools?.length;
  const mcpCount = currentPackRecord?.mcp?.length;

  const openPersonaDrawer = () => setShowPersonaDrawer(true);

  const proposed = branch?.proposed ?? [];
  const isLoadingThread = !isBranch && conv.loadingConversation && renderedMessages.length === 0 && !streaming;
  const isConversationEmpty = renderedMessages.length === 0 && !streaming && !isLoadingThread && proposed.length === 0;

  const handleSend = (rawText: string) => {
    const text = rawText.trim();
    if (!text || streaming) return;

    setError(null);
    setIsAtBottom(true);
    requestAnimationFrame(scrollToBottomInstant);

    if (branch) {
      branchTurn.handleBranchSend(rawText);
      return;
    }

    void conv.sendConversationTurn(text);
  };

  const handleStop = () => {
    if (isBranch) {
      branchTurn.handleBranchStop();
    } else {
      conv.handleStop();
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0 w-full bg-[var(--bark-950,#090d0b)] text-slate-200 font-sans overflow-hidden">
      <ChatHeader
        isBranch={isBranch}
        branch={branch}
        branchTree={branchTree}
        plannerPack={plannerPack}
        onOpenLab={() => setShellView('lab')}
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
        showProposals={showProposals}
        onToggleProposals={() => setShowProposals(!showProposals)}
        pendingCount={proposals.pendingCount}
        onNewChat={() => conv.createMutation.mutate()}
        isCreatingChat={conv.createMutation.isPending}
      />

      <div className="flex-1 min-h-0 flex flex-col sm:flex-row overflow-hidden relative">
        {!hideSidebar && !isBranch && (
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
                  {...(openPersonaDrawer ? { onOpenPersona: openPersonaDrawer } : {})}
                  {...(isBranch ? { headline: `Ask about ${branchTree?.name ?? 'this tree'}`, hideStarterPrompts: true } : {})}
                />

                <ChatComposer
                  onSend={handleSend}
                  onStop={handleStop}
                  isStreaming={streaming}
                  {...(activePack ? { activePack } : {})}
                  {...(openPersonaDrawer ? { onOpenPersonaDrawer: openPersonaDrawer } : {})}
                  {...(toolCount !== undefined ? { toolCount } : {})}
                  {...(mcpCount !== undefined ? { mcpCount } : {})}
                  modelLabel={modelLabel}
                  onOpenModelDrawer={() => setShowModelDrawer(true)}
                  {...(isBranch ? { placeholder: 'Send a message…  (/chat, /auto or /plan to switch mode)' } : {})}
                  {...(branch?.attachments ? { attachments: branch.attachments } : {})}
                  {...(branch?.onRemoveAttachment ? { onRemoveAttachment: branch.onRemoveAttachment } : {})}
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

                  {renderedMessages.map((msg, idx) => (
                    <ChatMessageRow
                      key={idx}
                      message={msg}
                      packLabel={isBranch ? 'Assistant' : (activePack?.label ?? '')}
                    />
                  ))}

                  {streaming && (
                    <ChatMessageRow
                      message={{
                        role: 'assistant',
                        content: isBranch ? branchTurn.liveState.live : conv.liveState.live,
                        reasoning: isBranch ? branchTurn.liveState.liveThinking : conv.liveState.liveThinking,
                        enabled: isBranch ? branchTurn.liveState.enabled : conv.liveState.enabled,
                        toolCalls: isBranch ? branchTurn.liveState.tools : conv.liveState.tools,
                      }}
                      packLabel={isBranch ? 'Assistant' : (activePack?.label ?? '')}
                      isStreaming={true}
                    />
                  )}

                  {isBranch && (
                    <SproutingLeavesCard
                      proposed={proposed}
                      onAccept={branch?.onAccept}
                      onReject={branch?.onReject}
                      onAcceptAll={branch?.onAcceptAll}
                    />
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
                    onSend={handleSend}
                    onStop={handleStop}
                    isStreaming={streaming}
                    {...(activePack ? { activePack } : {})}
                    {...(openPersonaDrawer ? { onOpenPersonaDrawer: openPersonaDrawer } : {})}
                    {...(toolCount !== undefined ? { toolCount } : {})}
                    {...(mcpCount !== undefined ? { mcpCount } : {})}
                    modelLabel={modelLabel}
                    onOpenModelDrawer={() => setShowModelDrawer(true)}
                    {...(isBranch ? { placeholder: 'Send a message…  (/chat, /auto or /plan to switch mode)' } : {})}
                    {...(branch?.attachments ? { attachments: branch.attachments } : {})}
                    {...(branch?.onRemoveAttachment ? { onRemoveAttachment: branch.onRemoveAttachment } : {})}
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
            liveTrees={proposals.liveTrees}
            persistedTrees={conv.activeConversation?.proposedTrees}
            onAcceptTree={(id) => conv.selectedConvId && proposals.acceptTreeMutation.mutate({ convId: conv.selectedConvId, proposalId: id })}
            onDismissTree={(id) => conv.selectedConvId && proposals.dismissTreeMutation.mutate({ convId: conv.selectedConvId, proposalId: id })}
            treeActionPending={proposals.acceptTreeMutation.isPending || proposals.dismissTreeMutation.isPending}
            liveSpecs={proposals.liveSpecs}
            persistedSpecs={conv.activeConversation?.proposedSpecs}
            onAcceptSpec={(id) => conv.selectedConvId && proposals.acceptSpecMutation.mutate({ convId: conv.selectedConvId, proposalId: id })}
            onDismissSpec={(id) => conv.selectedConvId && proposals.dismissSpecMutation.mutate({ convId: conv.selectedConvId, proposalId: id })}
            specActionPending={proposals.acceptSpecMutation.isPending || proposals.dismissSpecMutation.isPending}
            liveEscalations={proposals.liveEscalations}
            persistedEscalations={conv.activeConversation?.proposedEscalations}
            onAcceptEscalation={(id) => {
              const cid = conv.selectedConvId || conv.activeConversation?.id;
              if (cid) proposals.acceptEscalationMutation.mutate({ convId: cid, proposalId: id });
            }}
            onDenyEscalation={(id) => {
              const cid = conv.selectedConvId || conv.activeConversation?.id;
              if (cid) proposals.denyEscalationMutation.mutate({ convId: cid, proposalId: id });
            }}
            escalationActionPending={proposals.acceptEscalationMutation.isPending || proposals.denyEscalationMutation.isPending}
            liveSecretRequests={proposals.liveSecretRequests}
            persistedSecretRequests={conv.activeConversation?.proposedSecretRequests}
            onSubmitSecret={(id, value) => {
              const cid = conv.selectedConvId || conv.activeConversation?.id;
              if (cid) proposals.submitSecretMutation.mutate({ convId: cid, requestId: id, value });
            }}
            onDismissSecret={(id) => {
              const cid = conv.selectedConvId || conv.activeConversation?.id;
              if (cid) proposals.dismissSecretMutation.mutate({ convId: cid, requestId: id });
            }}
            secretActionPending={proposals.submitSecretMutation.isPending || proposals.dismissSecretMutation.isPending}
          />
        )}
      </div>

      <ModelConfigDrawer
        isOpen={showModelDrawer}
        onClose={() => setShowModelDrawer(false)}
        selectedModelId={activeModelId}
        onSelectModel={setActiveModelId}
      />

      <PersonaConfigDrawer
        isOpen={showPersonaDrawer}
        onClose={() => setShowPersonaDrawer(false)}
        activePackId={activePack?.id ?? plannerPack?.id ?? koalaPackId ?? 'koala'}
        onSelectPack={(packId) => {
          if (isBranch) {
            setBranchPlannerPackMutation.mutate(packId);
          }
        }}
      />
    </div>
  );
}
