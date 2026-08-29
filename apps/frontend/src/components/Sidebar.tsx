import React, { startTransition } from 'react';
import { useShellStore, type ViewName } from '../stores/shell';
import {
  Shield, FlaskConical, Trees, Trees as TreesIcon, ChevronDown, ChevronRight,
  Plus, Sprout, Box
} from 'lucide-react';
import { Koala } from './Koala';
import { useQuery } from '@tanstack/react-query';
import { listChatConversations, chatPackKeys, type ChatConversation } from '../api/chat-pack.js';
import { parseHash } from '../lib/route.js';

export interface ForestTab {
  id: string;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
}

export default function Sidebar({ forestTabs, onLogout }: {
  forestTabs: readonly ForestTab[];
  onLogout: () => void;
}) {
  const view = useShellStore((s) => s.view);
  const setView = useShellStore((s) => s.setView);
  const forestOpen = useShellStore((s) => s.forestOpen);
  const setForestOpen = useShellStore((s) => s.setForestOpen);

  const route = parseHash(typeof window !== 'undefined' ? window.location.hash : '');
  const activeConvId = route?.path[1];

  const { data: conversations = [] } = useQuery<ChatConversation[]>({
    queryKey: chatPackKeys.conversations(),
    queryFn: listChatConversations,
    staleTime: 30_000,
  });

  const navigateTo = (targetView: ViewName, hash?: string) => {
    startTransition(() => {
      if (hash) {
        window.location.hash = hash;
      }
      setView(targetView);
    });
  };

  const primary = (active: boolean) =>
    `w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-xs font-medium transition-colors cursor-pointer ${
      active ? 'bg-[var(--leaf-stem)] text-white' : 'text-slate-300 hover:bg-[var(--bark-700)]'}`;

  const nested = (active: boolean) =>
    `w-full flex items-center gap-2.5 pl-10 pr-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
      active ? 'bg-[var(--bark-600)] text-slate-100' : 'text-slate-400 hover:bg-[var(--bark-700)]'}`;

  return (
    <aside className="w-60 bg-[var(--bark-800)] border-r border-[var(--bark-600)] p-4 flex flex-col z-20 font-sans select-none">
      <div className="flex items-center gap-2.5 mb-6">
        <Koala size={34} mood="idle" />
        <div className="leading-none">
          <h1 className="text-base font-bold tracking-tight text-slate-100">NO WRINKLES</h1>
          <p className="text-[11px] text-[var(--leaf)] font-medium mt-1">Platform Operations</p>
        </div>
      </div>

      <nav className="space-y-1 flex-1 overflow-y-auto">
        <div>
          <button
            type="button"
            onClick={() => navigateTo('chat', '#/chat/koala')}
            className={primary(view === 'chat')}
          >
            <Koala size={20} mood={view === 'chat' ? 'happy' : 'idle'} />
            <span className="flex-1 text-left">Koala</span>
            {view === 'chat' && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  navigateTo('chat', '#/chat/koala');
                }}
                className="p-1 text-emerald-300 hover:text-white rounded hover:bg-emerald-800/40 transition-colors"
                title="New chat"
                aria-label="New chat"
              >
                <Plus size={13} />
              </button>
            )}
          </button>

          {conversations.length > 0 && (
            <div className="ml-4 pl-3 border-l border-[var(--bark-600)] space-y-0.5 my-1.5 animate-in fade-in duration-200">
              <div className="px-2 py-1 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                Recent Chats
              </div>
              {conversations.slice(0, 6).map((c) => {
                const isSelected = view === 'chat' && activeConvId === c.id;
                const hasTrees = Boolean(c.proposedTrees && c.proposedTrees.length > 0);
                const hasSpecs = Boolean(c.proposedSpecs && c.proposedSpecs.length > 0);

                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => navigateTo('chat', `#/chat/koala/${c.id}`)}
                    className={`w-full flex items-center justify-between gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-left transition-colors truncate cursor-pointer ${
                      isSelected
                        ? 'bg-[var(--bark-600)] text-emerald-300 font-semibold'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-[var(--bark-700)]'
                    }`}
                    title={c.title}
                  >
                    <span className="truncate flex-1">{c.title || 'Untitled'}</span>
                    {hasTrees && (
                      <span className="text-amber-400 shrink-0" title="Project Tree">
                        <Sprout size={11} />
                      </span>
                    )}
                    {hasSpecs && (
                      <span className="text-emerald-400 shrink-0" title="App Spec">
                        <Box size={11} />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => navigateTo('grove')}
          className={nested(view === 'grove')}
        >
          <TreesIcon size={15} /> Projects
        </button>

        <button
          type="button"
          onClick={() => navigateTo('personas')}
          className={nested(view === 'personas')}
        >
          <Shield size={15} className="text-[var(--leaf)]" /> Personas
        </button>

        <button
          type="button"
          onClick={() => navigateTo('lab')}
          className={nested(view === 'lab')}
        >
          <FlaskConical size={15} className="text-[var(--leaf)]" /> Lab
        </button>

        <button
          type="button"
          onClick={() => setForestOpen((o) => !o)}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-xs text-slate-300 hover:bg-[var(--bark-700)] transition-colors cursor-pointer"
        >
          <Trees size={16} className="text-[var(--leaf)]" />
          <span className="flex-1 text-left">Forest</span>
          {forestOpen
            ? <ChevronDown size={13} className="text-slate-400" />
            : <ChevronRight size={13} className="text-slate-400" />}
        </button>

        {forestOpen && (
          <div className="ml-3 pl-3 border-l border-[var(--bark-600)] space-y-0.5">
            {forestTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => navigateTo(tab.id as ViewName)}
                className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs transition-colors cursor-pointer ${
                  view === tab.id
                    ? 'bg-[var(--bark-600)] text-slate-100 font-medium'
                    : 'text-slate-400 hover:bg-[var(--bark-700)] hover:text-slate-200'
                }`}
              >
                <tab.icon size={14} /> {tab.label}
              </button>
            ))}
          </div>
        )}
      </nav>

      <div className="pt-3 border-t border-[var(--bark-600)] space-y-2">
        <button
          type="button"
          onClick={onLogout}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-red-400 hover:bg-red-500/10 rounded-md transition-colors cursor-pointer text-xs font-medium"
        >
          Log Out
        </button>
        <div className="flex items-center gap-2 text-slate-400 text-xs px-3">
          <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-sm" />
          <span>System Online</span>
        </div>
      </div>
    </aside>
  );
}
