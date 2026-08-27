import React, { useState, useMemo } from 'react';
import {
  Search, Plus, Trash2, X, ChevronLeft,
  MessageSquare, History, Sprout, Box
} from 'lucide-react';
import type { ChatConversation } from '../api/chat-pack.js';

export interface CollapsibleHistoryListProps {
  conversations: ChatConversation[];
  activeId?: string | undefined;
  isOpen: boolean;
  onToggle: () => void;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onDelete: (id: string) => void;
  className?: string | undefined;
}

export const CollapsibleHistoryList: React.FC<CollapsibleHistoryListProps> = ({
  conversations,
  activeId,
  isOpen,
  onToggle,
  onSelect,
  onNewChat,
  onDelete,
  className = '',
}) => {
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    if (!search.trim()) return conversations;
    const q = search.toLowerCase();
    return conversations.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        (c.messages && c.messages.some((m) => m.content.toLowerCase().includes(q))),
    );
  }, [conversations, search]);

  if (!isOpen) return null;

  return (
    <aside
      data-testid="history-list-panel"
      className={`w-72 sm:w-80 h-full flex-none flex flex-col bg-[var(--bark-950,#060908)] border-r border-[var(--bark-800,#1b2620)] select-none font-sans text-slate-300 z-20 transition-all ${className}`}
    >
      {/* Header Bar */}
      <div className="flex items-center justify-between px-3.5 py-3 border-b border-[var(--bark-800,#1b2620)] bg-[var(--bark-900,#0f1713)]">
        <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
          <History size={14} className="text-emerald-400" />
          <span>Chat History</span>
          <span className="text-[11px] text-slate-400 bg-[var(--bark-950,#060908)] px-1.5 py-0.5 rounded border border-[var(--bark-800,#1b2620)] font-mono">
            {conversations.length}
          </span>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onNewChat}
            className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md bg-emerald-600 hover:bg-emerald-500 text-white transition-colors cursor-pointer"
            title="Start new chat"
          >
            <Plus size={13} strokeWidth={2} />
            <span>New</span>
          </button>
          <button
            type="button"
            onClick={onToggle}
            className="p-1 rounded-md text-slate-400 hover:text-slate-200 hover:bg-[var(--bark-800,#1b2620)] transition-colors cursor-pointer"
            title="Collapse history"
            aria-label="Collapse history"
          >
            <ChevronLeft size={16} className="hidden sm:block" />
            <X size={16} className="sm:hidden" />
          </button>
        </div>
      </div>

      {/* Search Input */}
      <div className="p-2 border-b border-[var(--bark-800,#1b2620)] bg-[var(--bark-900,#0f1713)]/40">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search conversations..."
            className="w-full pl-8 pr-3 py-1 text-xs bg-[var(--bark-950,#060908)] border border-[var(--bark-800,#1b2620)] rounded-md text-slate-200 placeholder-slate-500 focus:outline-none focus:border-emerald-500/60 transition-colors"
          />
        </div>
      </div>

      {/* Conversation Scrollable List */}
      <div className="flex-1 overflow-y-auto p-1.5 space-y-1">
        {filtered.length === 0 ? (
          <div className="text-center py-8 text-xs text-slate-500">
            {search ? 'No matching conversations' : 'No saved conversations'}
          </div>
        ) : (
          filtered.map((c) => {
            const isActive = c.id === activeId;
            const hasTrees = Boolean(c.proposedTrees && c.proposedTrees.length > 0);
            const hasSpecs = Boolean(c.proposedSpecs && c.proposedSpecs.length > 0);
            const msgCount = c.messageCount ?? c.messages?.length ?? 1;
            const formattedDate = c.updatedAt
              ? new Date(c.updatedAt).toLocaleDateString([], {
                  month: 'short',
                  day: 'numeric',
                })
              : '';

            return (
              <div
                key={c.id}
                onClick={() => onSelect(c.id)}
                className={`group relative p-2.5 rounded-lg border cursor-pointer transition-colors ${
                  isActive
                    ? 'bg-[var(--bark-800,#1b2620)] border-emerald-500/50 text-slate-100'
                    : 'bg-[var(--bark-900,#0f1713)]/40 border-[var(--bark-800,#1b2620)] hover:border-slate-600 text-slate-300'
                }`}
              >
                {/* Top Row: Title + Delete */}
                <div className="flex items-start justify-between gap-2">
                  <div className="text-xs font-medium leading-snug truncate pr-1 text-slate-200">
                    {c.title || 'Untitled conversation'}
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(c.id);
                    }}
                    className="opacity-0 group-hover:opacity-100 p-1 rounded-md text-slate-500 hover:text-red-400 hover:bg-black/20 transition-all"
                    title="Delete conversation"
                    aria-label="Delete conversation"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>

                {/* Bottom Row: Metadata & Badges */}
                <div className="flex items-center justify-between mt-2 text-[11px] text-slate-400">
                  <div className="flex items-center gap-2 font-sans">
                    <span className="flex items-center gap-1">
                      <MessageSquare size={11} className="text-slate-500" />
                      {msgCount} {msgCount === 1 ? 'msg' : 'msgs'}
                    </span>
                    {formattedDate && <span>· {formattedDate}</span>}
                  </div>

                  <div className="flex items-center gap-1.5">
                    {hasTrees && (
                      <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-amber-950/60 border border-amber-500/30 text-[10px] text-amber-300 font-medium" title="Project Tree Proposal">
                        <Sprout size={10} />
                        <span>Tree</span>
                      </span>
                    )}
                    {hasSpecs && (
                      <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-emerald-950/60 border border-emerald-500/30 text-[10px] text-emerald-300 font-medium" title="App Spec Proposal">
                        <Box size={10} />
                        <span>Spec</span>
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
};

export default CollapsibleHistoryList;
