import { useState } from 'react';
import {
  History, ChevronDown, Plus
} from 'lucide-react';
import type { ChatConversation } from '../../api/chat-pack.js';

export interface ChatHeaderProps {
  hideSidebar?: boolean | undefined;
  showHistory?: boolean;
  onToggleHistory?: () => void;
  selectedConvId?: string | null;
  activeConversation?: ChatConversation | null | undefined;
  conversations?: ChatConversation[];
  onSelectConversation?: (id: string) => void;
  onNewChat?: () => void;
  isCreatingChat?: boolean;
}

export function ChatHeader({
  hideSidebar = false,
  showHistory = false,
  onToggleHistory,
  selectedConvId,
  activeConversation,
  conversations = [],
  onSelectConversation,
  onNewChat,
  isCreatingChat = false,
}: ChatHeaderProps) {
  const [showDropdown, setShowDropdown] = useState(false);

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
