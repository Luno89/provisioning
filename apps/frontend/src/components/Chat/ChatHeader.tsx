import { useState } from 'react';
import {
  History, ChevronDown, ShieldAlert, Inbox, Plus, AlertTriangle
} from 'lucide-react';
import type { ChatConversation } from '../../api/chat-pack.js';
import type { ChatMode, ChatScope } from './hooks/useBranchTurn.js';

export const MODE_HINT: Record<ChatMode, string> = {
  chat: 'just talking — nothing is created',
  auto: 'work is extracted from every reply',
  plan: 'actively breaking the work down',
};

export interface ChatHeaderProps {
  isBranch: boolean;
  branch?: ChatScope | undefined;
  branchTree?: { id: string; name: string } | undefined;
  plannerPack?: { id: string; name: string } | undefined;
  onOpenLab?: () => void;
  hideSidebar?: boolean | undefined;
  showHistory?: boolean;
  onToggleHistory?: () => void;
  selectedConvId?: string | null;
  activeConversation?: ChatConversation | null | undefined;
  conversations?: ChatConversation[];
  onSelectConversation?: (id: string) => void;
  showProposals?: boolean;
  onToggleProposals?: () => void;
  pendingCount?: number;
  onNewChat?: () => void;
  isCreatingChat?: boolean;
}

export function ChatHeader({
  isBranch,
  branch,
  branchTree,
  plannerPack,
  onOpenLab,
  hideSidebar = false,
  showHistory = false,
  onToggleHistory,
  selectedConvId,
  activeConversation,
  conversations = [],
  onSelectConversation,
  showProposals = false,
  onToggleProposals,
  pendingCount = 0,
  onNewChat,
  isCreatingChat = false,
}: ChatHeaderProps) {
  const [showDropdown, setShowDropdown] = useState(false);

  if (isBranch && branch) {
    return (
      <div className="flex-none flex items-center justify-between gap-3 px-4 py-2.5 bg-[var(--bark-900,#111814)] border-b border-[var(--bark-800,#1b2620)] select-none font-sans">
        <div className="flex items-center gap-2 text-[11px] min-w-0">
          <span className={`font-mono ${branch.mode === 'chat' ? 'text-slate-500' : branch.mode === 'plan' ? 'text-emerald-400' : 'text-blue-400'}`}>
            /{branch.mode}
          </span>
          <span className="text-slate-600">{MODE_HINT[branch.mode]}</span>
          {branchTree && (
            <>
              <span className="text-slate-700">·</span>
              <span className="text-slate-400 truncate">scoped to {branchTree.name}</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2 relative">
          {!plannerPack && onOpenLab && (
            <button
              type="button"
              onClick={onOpenLab}
              title="No planner pack is assigned to this project type — set one in Lab > Tree Types"
              className="flex items-center gap-1 text-amber-500/90 hover:text-amber-400 truncate cursor-pointer text-[11px]"
            >
              <AlertTriangle size={11} className="shrink-0" />
              <span className="truncate">No planner pack assigned</span>
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-none flex items-center justify-between gap-3 px-4 py-2.5 bg-[var(--bark-900,#111814)] border-b border-[var(--bark-800,#1b2620)] select-none font-sans">
      <div className="flex items-center gap-2">
        {!hideSidebar && onToggleHistory && (
          <button
            type="button"
            aria-label="Toggle history"
            onClick={onToggleHistory}
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
                      onSelectConversation?.(c.id);
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

      <div className="flex items-center gap-2">
        {activeConversation?.isEscalated && (
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-amber-500/15 border border-amber-500/40 text-amber-300 text-[11px] font-mono select-none">
            <ShieldAlert size={12} className="text-amber-400" />
            <span>ELEVATED ({activeConversation.escalatedScope ?? 'cluster-read'})</span>
          </div>
        )}
        {!hideSidebar && !isBranch && onToggleProposals && (
          <button
            type="button"
            aria-label="Toggle proposals"
            onClick={onToggleProposals}
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
        {onNewChat && (
          <button
            type="button"
            onClick={onNewChat}
            disabled={isCreatingChat}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-md text-xs font-medium transition-colors cursor-pointer disabled:opacity-50"
          >
            <Plus size={13} />
            <span>New Chat</span>
          </button>
        )}
      </div>
    </div>
  );
}
