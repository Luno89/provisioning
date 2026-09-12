import React, { useState, useEffect, startTransition } from 'react';
import { useRouter } from '@tanstack/react-router';
import { useShellStore, type ViewName } from '../stores/shell';
import {
  Shield, FlaskConical, Trees, Trees as TreesIcon, ChevronDown, ChevronRight,
  Plus, Sprout, Box, Sliders, Wrench, Trash2, GitBranch
} from 'lucide-react';
import { Koala } from './Koala';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listChatConversations, deleteChatConversation, chatPackKeys, type ChatConversation,
} from '../api/chat-pack.js';
import { listTrees, groveKeys } from '../api/grove.js';
import { parseHash, formatHash } from '../lib/route.js';

export interface ForestTab {
  id: string;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
}

function useSafeRouter() {
  const router = useRouter({ warn: false });
  const [pathname, setPathname] = useState(() => (router?.state?.location?.pathname as string) ?? null);

  useEffect(() => {
    if (!router?.subscribe) return;
    return router.subscribe('onResolved', (evt: any) => {
      setPathname(evt?.toLocation?.pathname ?? null);
    });
  }, [router]);

  return {
    pathname,
    navigate: router ? (opts: any) => router.navigate(opts) : null,
  };
}

export default function Sidebar({ forestTabs, onLogout }: {
  forestTabs: readonly ForestTab[];
  onLogout: () => void;
}) {
  const view = useShellStore((s) => s.view);
  const setView = useShellStore((s) => s.setView);
  const forestOpen = useShellStore((s) => s.forestOpen);
  const setForestOpen = useShellStore((s) => s.setForestOpen);
  const koalaOpen = useShellStore((s) => s.koalaOpen);
  const setKoalaOpen = useShellStore((s) => s.setKoalaOpen);
  const projectsOpen = useShellStore((s) => s.projectsOpen);
  const setProjectsOpen = useShellStore((s) => s.setProjectsOpen);

  const { pathname: routerPath, navigate } = useSafeRouter();

  const [currentHash, setCurrentHash] = useState(() => (typeof window !== 'undefined' ? window.location.hash : ''));

  useEffect(() => {
    const handleHash = () => setCurrentHash(window.location.hash);
    window.addEventListener('hashchange', handleHash);
    window.addEventListener('popstate', handleHash);
    return () => {
      window.removeEventListener('hashchange', handleHash);
      window.removeEventListener('popstate', handleHash);
    };
  }, []);

  const route = parseHash(currentHash);

  const activeConvId = routerPath
    ? (routerPath.startsWith('/chat/') ? routerPath.split('/')[2] : undefined)
    : (view === 'chat' ? route?.path[0] : undefined);

  const activeTreeId = routerPath
    ? (routerPath.startsWith('/projects/tree/') ? routerPath.split('/')[3] : undefined)
    : (view === 'projects' && route?.path[0] === 'tree' ? route?.path[1] : undefined);

  const isCurrentView = (id: string) => {
    if (routerPath) {
      if (id === 'chat') return routerPath === '/chat' || routerPath.startsWith('/chat/');
      if (id === 'projects') return routerPath === '/projects' || routerPath.startsWith('/projects/');
      return routerPath === `/${id}` || routerPath.startsWith(`/${id}/`);
    }
    return view === id;
  };

  const qc = useQueryClient();

  const { data: conversations = [] } = useQuery<ChatConversation[]>({
    queryKey: chatPackKeys.conversations(),
    queryFn: listChatConversations,
    staleTime: 30_000,
  });

  const { data: trees = [] } = useQuery({
    queryKey: groveKeys.trees(),
    queryFn: listTrees,
    staleTime: 30_000,
  });

  const navigateTo = (targetView: ViewName, hashOrPath?: string) => {
    startTransition(() => {
      setView(targetView);
      const target = hashOrPath ?? formatHash(targetView);
      const cleanPath = target.replace(/^#/, '');
      const hash = target.startsWith('#') ? target : `#${target}`;
      window.location.hash = hash;
      setCurrentHash(hash);
      if (navigate) {
        navigate({ to: cleanPath as any }).catch(() => {});
      }
    });
  };

  const deleteConversation = useMutation({
    mutationFn: (id: string) => deleteChatConversation(id),
    onSuccess: (_, deletedId) => {
      qc.invalidateQueries({ queryKey: chatPackKeys.conversations() });
      if (activeConvId === deletedId) navigateTo('chat', '#/chat');
    },
  });

  const nested = (active: boolean) =>
    `w-full flex items-center gap-2.5 pl-10 pr-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
      active ? 'bg-[var(--bark-600)] text-slate-100' : 'text-slate-400 hover:bg-[var(--bark-700)]'}`;

  const groupHeader = (active: boolean) =>
    `w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-xs font-medium transition-colors cursor-pointer ${
      active ? 'bg-[var(--leaf-stem)] text-white' : 'text-slate-300 hover:bg-[var(--bark-700)]'}`;

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
        <button
          type="button"
          onClick={() => {
            if (isCurrentView('chat')) {
              setKoalaOpen((o) => !o);
            } else {
              navigateTo('chat', '#/chat');
              setKoalaOpen(true);
            }
          }}
          className={groupHeader(isCurrentView('chat'))}
        >
          <Koala size={18} mood={isCurrentView('chat') ? 'happy' : 'idle'} />
          <span className="flex-1 text-left">Koala</span>
          {isCurrentView('chat') && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                navigateTo('chat', '#/chat');
              }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.stopPropagation();
                e.preventDefault();
                navigateTo('chat', '#/chat');
              }}
              className="p-1 text-emerald-300 hover:text-white rounded hover:bg-emerald-800/40 transition-colors cursor-pointer"
              title="New chat"
              aria-label="New chat"
            >
              <Plus size={13} />
            </span>
          )}
          {koalaOpen
            ? <ChevronDown size={13} className="text-slate-400" />
            : <ChevronRight size={13} className="text-slate-400" />}
        </button>

        {koalaOpen && conversations.length > 0 && (
          <div className="ml-3 pl-3 border-l border-[var(--bark-600)] space-y-0.5 my-1.5 animate-in fade-in duration-200">
            <div className="px-2 py-1 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
              Recent Chats
            </div>
            {conversations.slice(0, 6).map((c) => {
              const isSelected = isCurrentView('chat') && activeConvId === c.id;
              const hasTrees = Boolean(c.proposedTrees && c.proposedTrees.length > 0);
              const hasSpecs = Boolean(c.proposedSpecs && c.proposedSpecs.length > 0);

              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => navigateTo('chat', `#/chat/${c.id}`)}
                  className={`group w-full flex items-center justify-between gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-left transition-colors truncate cursor-pointer ${
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
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteConversation.mutate(c.id);
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' && e.key !== ' ') return;
                      e.stopPropagation();
                      e.preventDefault();
                      deleteConversation.mutate(c.id);
                    }}
                    className="opacity-0 group-hover:opacity-100 shrink-0 p-0.5 rounded text-slate-500 hover:text-red-400 hover:bg-black/20 transition-all cursor-pointer"
                    title="Delete conversation"
                    aria-label="Delete conversation"
                  >
                    <Trash2 size={11} />
                  </span>
                </button>
              );
            })}
          </div>
        )}

        <button
          type="button"
          onClick={() => {
            if (isCurrentView('projects')) {
              setProjectsOpen((o) => !o);
            } else {
              navigateTo('projects');
              setProjectsOpen(true);
            }
          }}
          className={groupHeader(isCurrentView('projects'))}
        >
          <TreesIcon size={16} />
          <span className="flex-1 text-left">Projects</span>
          {projectsOpen
            ? <ChevronDown size={13} className="text-slate-400" />
            : <ChevronRight size={13} className="text-slate-400" />}
        </button>

        {projectsOpen && trees.length > 0 && (
          <div className="ml-3 pl-3 border-l border-[var(--bark-600)] space-y-0.5">
            {trees.slice(0, 6).map((t) => {
              const isSelected = isCurrentView('projects') && activeTreeId === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => navigateTo('projects', `#/projects/tree/${t.id}`)}
                  className={`w-full flex items-center justify-between gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-left transition-colors truncate cursor-pointer ${
                    isSelected
                      ? 'bg-[var(--bark-600)] text-emerald-300 font-semibold'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-[var(--bark-700)]'
                  }`}
                  title={t.name}
                >
                  <span className="truncate flex-1">{t.name || 'Untitled'}</span>
                  <span className="text-[10px] text-slate-500 shrink-0">{t.branchCount}</span>
                </button>
              );
            })}
          </div>
        )}

        <button
          type="button"
          onClick={() => navigateTo('personas')}
          className={nested(isCurrentView('personas'))}
        >
          <Shield size={15} className="text-[var(--leaf)]" /> Personas
        </button>

        <button
          type="button"
          onClick={() => navigateTo('lab')}
          className={nested(isCurrentView('lab'))}
        >
          <FlaskConical size={15} className="text-[var(--leaf)]" /> Lab
        </button>

        <button
          type="button"
          onClick={() => navigateTo('harness')}
          className={nested(isCurrentView('harness'))}
        >
          <Sliders size={15} className="text-[var(--leaf)]" /> Harness
        </button>

        <button
          type="button"
          onClick={() => navigateTo('tree-types')}
          className={nested(isCurrentView('tree-types'))}
        >
          <GitBranch size={15} className="text-[var(--leaf)]" /> Tree Types
        </button>

        <button
          type="button"
          onClick={() => navigateTo('tool-repo')}
          className={nested(isCurrentView('tool-repo'))}
        >
          <Wrench size={15} className="text-[var(--leaf)]" /> Tool Repo
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
                  isCurrentView(tab.id)
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
