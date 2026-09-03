import { useState, useMemo, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ChevronRight, ChevronDown, GitBranch, Plus, Loader2,
  PanelLeftClose, PanelLeftOpen, Trash2, Trees as TreesIcon, Inbox, AlertTriangle } from 'lucide-react';
import BranchChat, { type BranchRecord } from './BranchChat.js';
import Home from './Home.js';
import NewTreeDialog from './NewTreeDialog.js';
import LeafDetail from './LeafDetail.js';
import { STATE_DOT, STATE_LABEL, CANCELLED_DOT, stateFor, type Leaf } from './leaf-types.js';
import { type ChatMessageRecord as Message } from './ChatSurface.js';
import { parseHash, formatHash, shouldReplace } from '../lib/route.js';
import { lastSeen, markSeenAfterDwell } from '../lib/seen.js';
import {
  listTrees, listBranches, listLeaves, patchBranch, acceptLeaf,
  createBranch as apiCreateBranch,
  deleteTree as apiDeleteTree,
  deleteBranch as apiDeleteBranch,
  deleteLeaf as apiDeleteLeaf,
} from '../api/grove';
import { listPacks } from '../api/packs';
import { useLiveTurnsStore, branchTurnKey, overlayBranchMessages } from '../stores/live-turns.js';

interface Tree {
  id: string;
  name: string;
  type: string;
  goal?: string;
  branchCount: number;
  updatedAt: string;
}

const UNFILED = '__unfiled__';

export default function Grove({ handoff, onHandoffTaken }: {
  handoff?: { branchId: string; prompt: string } | undefined;
  onHandoffTaken?: () => void;
}) {
  const qc = useQueryClient();

  const fromUrl = parseHash(window.location.hash);
  const urlPath = fromUrl?.view === 'grove' ? fromUrl.path : [];
  const [openTree, setOpenTree] = useState<string>(() => urlPath[0] ?? localStorage.getItem('grove-tree') ?? '');
  const [selected, setSelected] = useState<{ kind: 'tree' | 'branch' | 'leaf'; id: string }>(() => {
    if (urlPath[2]) return { kind: 'leaf', id: urlPath[2] };
    if (urlPath[1]) return { kind: 'branch', id: urlPath[1] };
    return { kind: 'tree', id: urlPath[0] ?? localStorage.getItem('grove-tree') ?? '' };
  });

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [railClosed, setRailClosed] = useState(false);
  const [newTree, setNewTree] = useState(false);
  const [transcripts, setTranscripts] = useState<Record<string, Message[]>>({});
  const liveTurns = useLiveTurnsStore((s) => s.turns);
  const [modes, setModes] = useState<Record<string, 'chat' | 'auto' | 'plan'>>({});
  const [opening, setOpening] = useState<{ branchId: string; prompt: string } | undefined>();

  const seenAt = useRef<string | undefined>(lastSeen('grove-seen'));
  useEffect(() => markSeenAfterDwell('grove-seen'), []);

  useEffect(() => {
    if (openTree) localStorage.setItem('grove-tree', openTree);
  }, [openTree]);

  const { data: trees = [] } = useQuery<Tree[]>({
    queryKey: ['trees'],
    queryFn: () => listTrees() as Promise<Tree[]>,
  });
  const { data: branchRecords = [] } = useQuery<BranchRecord[]>({
    queryKey: ['branches'],
    queryFn: () => listBranches() as Promise<BranchRecord[]>,
    refetchInterval: 10000,
  });
  const { data: leaves, isLoading } = useQuery<Leaf[]>({
    queryKey: ['leaves'],
    queryFn: listLeaves,
    refetchInterval: 5000,
  });
  const { data: packs = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ['packs'],
    queryFn: listPacks,
    staleTime: 60_000,
  });

  const all = useMemo(() => leaves ?? [], [leaves]);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['leaves'] });
    qc.invalidateQueries({ queryKey: ['branches'] });
  };

  const groups = useMemo(() => {
    const leavesAll = leaves ?? [];
    const out = trees.map((t) => ({
      id: t.id,
      name: t.name,
      goal: t.goal,
      branches: branchRecords.filter((b) => b.treeId === t.id),
    }));
    const orphans = branchRecords.filter((b) => !b.treeId || !trees.some((t) => t.id === b.treeId));

    const known = new Set(branchRecords.map((b) => b.id));
    const stranded = [...new Set(leavesAll.filter((l) => !known.has(l.branchId)).map((l) => l.branchId))]
      .map((id) => ({
        id,
        title: leavesAll.find((l) => l.branchId === id && !l.parentLeafId)?.title ?? 'Untitled conversation',
        messages: [],
        updatedAt: leavesAll.reduce((newest, l) => (l.branchId === id && l.updatedAt > newest ? l.updatedAt : newest), ''),
      } as BranchRecord));
    orphans.push(...stranded);

    if (orphans.length > 0) {
      out.push({ id: UNFILED, name: 'Unfiled', goal: 'Conversations not filed under a tree', branches: orphans });
    }
    return out;
  }, [trees, branchRecords, leaves]);

  const leavesOf = (branchId: string) => all.filter((l) => l.branchId === branchId && !l.parentLeafId);
  const childrenOf = (leafId: string) => all.filter((l) => l.parentLeafId === leafId);

  const createBranch = useMutation({
    mutationFn: (treeId: string) =>
      apiCreateBranch<BranchRecord>(treeId && treeId !== UNFILED ? { treeId } : {}),
    onSuccess: (branch: BranchRecord) => {
      setSelected({ kind: 'branch', id: branch.id });
      qc.invalidateQueries({ queryKey: ['branches'] });
    },
  });

  const startWork = useMutation({
    mutationFn: ({ treeId }: { treeId: string; prompt: string }) =>
      apiCreateBranch<BranchRecord>(treeId && treeId !== UNFILED ? { treeId } : {}),
    onSuccess: (branch, { treeId, prompt }) => {
      setOpenTree(treeId);
      setSelected({ kind: 'branch', id: branch.id });
      setOpening({ branchId: branch.id, prompt });
      qc.invalidateQueries({ queryKey: ['branches'] });
    },
  });
  const deleteTree = useMutation({
    mutationFn: (id: string) => apiDeleteTree(id),
    onSuccess: (_, id) => {
      if (openTree === id) { setOpenTree(''); setSelected({ kind: 'tree', id: '' }); }
      qc.invalidateQueries({ queryKey: ['trees'] });
      qc.invalidateQueries({ queryKey: ['branches'] });
    },
  });

  const deleteBranch = useMutation({
    mutationFn: (id: string) => apiDeleteBranch(id),
    onSuccess: (_, id) => {
      setTranscripts((prev) => { const copy = { ...prev }; delete copy[id]; return copy; });
      if (selected.kind === 'branch' && selected.id === id) setSelected({ kind: 'tree', id: openTree });
      refresh();
    },
  });
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const refusal = (err: any) =>
    err?.response?.data?.error ?? err?.message ?? 'That could not be accepted.';

  const accept = useMutation({
    mutationFn: (id: string) => acceptLeaf(id),
    onSuccess: () => { setAcceptError(null); refresh(); },
    onError: (err) => setAcceptError(refusal(err)),
  });
  const reject = useMutation({
    mutationFn: (id: string) => apiDeleteLeaf(id),
    onSuccess: refresh,
  });
  const acceptAll = useMutation({
    mutationFn: async (ids: string[]) => {
      let failed: string | null = null;
      for (const id of ids) {
        await acceptLeaf(id)
          .catch((err) => { if (!failed) failed = refusal(err); });
      }
      setAcceptError(failed);
    },
    onSuccess: refresh,
  });

  const openedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!handoff || openedRef.current === handoff.branchId) return;
    openedRef.current = handoff.branchId;
    const record = branchRecords.find((b) => b.id === handoff.branchId);
    if (record?.treeId) setOpenTree(record.treeId);
    setSelected({ kind: 'branch', id: handoff.branchId });
  }, [handoff, branchRecords]);

  const selectedLeaf = selected.kind === 'leaf' ? all.find((l) => l.id === selected.id) : undefined;
  const selectedBranch = selected.kind === 'branch'
    ? branchRecords.find((b) => b.id === selected.id)
      ?? ({ id: selected.id, title: 'Conversation', messages: [], updatedAt: '' } as BranchRecord)
    : undefined;
  const scopeTree = trees.find((t) => t.id === openTree);
  const projectTree = selected.kind === 'tree' && selected.id && selected.id !== UNFILED
    ? trees.find((t) => t.id === selected.id)
    : undefined;

  useEffect(() => {
    const branchId = selected.kind === 'branch' ? selected.id : selectedLeaf?.branchId ?? '';
    const path = [openTree, branchId, selected.kind === 'leaf' ? selected.id : ''];
    const hash = formatHash('grove', path);
    if (window.location.hash === hash) return;
    const current = parseHash(window.location.hash);
    const next = { view: 'grove', path: path.filter(Boolean) };
    if (shouldReplace(current, next)) window.history.replaceState(null, '', hash);
    else window.history.pushState(null, '', hash);
  }, [openTree, selected, selectedLeaf]);

  const renderLeaf = (leaf: Leaf, depth: number) => {
    const kids = childrenOf(leaf.id);
    const isCollapsed = collapsed[leaf.id] ?? false;
    const isSelected = selected.kind === 'leaf' && selected.id === leaf.id;
    const state = stateFor(leaf, all);
    return (
      <div key={leaf.id}>
        <div
          onClick={() => setSelected({ kind: 'leaf', id: leaf.id })}
          className={`flex items-center gap-1.5 py-1 pr-2 rounded-md cursor-pointer text-[13px] ${isSelected ? 'bg-[var(--bark-700)] text-slate-100' : 'text-slate-400 hover:bg-[var(--bark-800)]'}`}
          style={{ paddingLeft: `${depth * 12 + 20}px` }}
        >
          {kids.length > 0 ? (
            <button
              onClick={(e) => { e.stopPropagation(); setCollapsed((c) => ({ ...c, [leaf.id]: !isCollapsed })); }}
              className="text-slate-600 hover:text-slate-300 shrink-0"
            >
              {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
            </button>
          ) : <span className="w-3 shrink-0" />}
          <span
            className={`w-1.5 h-1.5 rounded-full shrink-0 ${state ? STATE_DOT[state] : CANCELLED_DOT}`}
            title={state ? STATE_LABEL[state] : 'Cancelled'}
          />
          <span className="truncate">{leaf.title}</span>
          {kids.length > 0 && <span className="text-[10px] text-slate-600 shrink-0">{kids.length}</span>}
        </div>
        {!isCollapsed && kids.map((k) => renderLeaf(k, depth + 1))}
      </div>
    );
  };

  return (
    <div className="flex h-[calc(100vh-7rem)] gap-0 relative">
      {acceptError && (
        <div className="absolute top-0 left-0 right-0 z-30 m-2 rounded-xl border border-amber-500/40 bg-amber-950/60 px-4 py-2.5 flex items-start gap-3">
          <AlertTriangle size={15} className="text-amber-400 shrink-0 mt-0.5" />
          <p className="text-[12px] text-amber-100 leading-relaxed flex-1">{acceptError}</p>
          <button onClick={() => setAcceptError(null)} className="text-amber-400/70 hover:text-amber-200 text-[11px]">
            dismiss
          </button>
        </div>
      )}
      <aside className={`${railClosed ? 'w-0 opacity-0 overflow-hidden hidden' : 'w-72 pr-3'} shrink-0 border-r border-[var(--bark-600)] overflow-y-auto transition-all duration-200`}>
        <div className="flex items-center justify-between mb-3 pl-2">
          <h2 className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Grove</h2>
          <div className="flex items-center gap-1">
            <button onClick={() => setNewTree(true)} title="New tree" className="text-slate-600 hover:text-[var(--leaf)] p-0.5 rounded">
              <Plus size={14} />
            </button>
            <button onClick={() => setRailClosed(true)} title="Hide the navigator" className="text-slate-600 hover:text-slate-300 p-0.5 rounded">
              <PanelLeftClose size={14} />
            </button>
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 text-slate-500 text-xs pl-2"><Loader2 className="animate-spin" size={12} /> Loading…</div>
        ) : groups.map((group) => {
          const isOpen = openTree === group.id;
          return (
            <div key={group.id} className="mb-1">
              <div
                onClick={() => { setOpenTree(group.id); setSelected({ kind: 'tree', id: group.id }); }}
                className={`group flex items-center gap-1.5 py-1.5 px-2 rounded-md cursor-pointer text-[13px] font-semibold ${
                  selected.kind === 'tree' && selected.id === group.id ? 'bg-[var(--bark-700)] text-slate-100' : 'text-slate-300 hover:bg-[var(--bark-800)]'
                }`}
              >
                <button
                  onClick={(e) => { e.stopPropagation(); setOpenTree(isOpen ? '' : group.id); }}
                  title={isOpen ? 'Collapse tree' : 'Expand tree'}
                  className="text-slate-500 hover:text-slate-300 shrink-0"
                >
                  {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                </button>
                {group.id === UNFILED
                  ? <Inbox size={13} className="shrink-0 text-slate-500" />
                  : <TreesIcon size={13} className="shrink-0 text-[var(--leaf)]" />}
                <span className="truncate flex-1 min-w-0">{group.name}</span>
                <span className="text-[10px] text-slate-600 shrink-0 group-hover:hidden">{group.branches.length}</span>
                {group.id !== UNFILED && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm(`Delete tree "${group.name}"? Its conversations survive, un-filed.`)) deleteTree.mutate(group.id);
                    }}
                    title="Delete this tree. Its conversations survive, un-filed."
                    className="text-slate-500 hover:text-red-400 p-0.5 rounded hidden group-hover:block shrink-0"
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>

              {isOpen && group.branches.map((branch) => {
                const roots = leavesOf(branch.id);
                const bCollapsed = collapsed[branch.id] ?? false;
                const bSelected = selected.kind === 'branch' && selected.id === branch.id;
                return (
                  <div key={branch.id}>
                    <div
                      onClick={() => setSelected({ kind: 'branch', id: branch.id })}
                      className={`group flex items-center gap-1.5 py-1 pl-4 pr-2 rounded-md cursor-pointer text-[13px] ${bSelected ? 'bg-[var(--bark-700)] text-slate-100' : 'text-slate-300 hover:bg-[var(--bark-800)]'}`}
                    >
                      <button
                        onClick={(e) => { e.stopPropagation(); setCollapsed((c) => ({ ...c, [branch.id]: !bCollapsed })); }}
                        className="text-slate-600 hover:text-slate-300 shrink-0"
                      >
                        {bCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                      </button>
                      <GitBranch size={12} className="text-slate-500 shrink-0" />
                      <span className="truncate flex-1 min-w-0">{branch.title}</span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm(`Delete branch "${branch.title}" and all its leaves?`)) deleteBranch.mutate(branch.id);
                        }}
                        title="Delete branch"
                        className="text-slate-500 hover:text-red-400 p-0.5 rounded opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity shrink-0"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                    {!bCollapsed && roots.map((l) => renderLeaf(l, 1))}
                  </div>
                );
              })}

              {isOpen && (
                <button
                  onClick={() => createBranch.mutate(group.id)}
                  className="flex items-center gap-1.5 pl-6 py-1 text-[12px] text-slate-600 hover:text-[var(--leaf)]"
                >
                  <Plus size={12} /> new conversation
                </button>
              )}
            </div>
          );
        })}
      </aside>

      <section className="flex-1 min-w-0 pl-6 overflow-hidden flex flex-col relative">
        {railClosed && (
          <button
            onClick={() => setRailClosed(false)}
            title="Show the navigator"
            className="absolute top-0 left-0 z-10 p-1.5 rounded-lg border border-[var(--bark-600)] bg-[var(--bark-900)] text-slate-400 hover:text-slate-200 shadow-md"
          >
            <PanelLeftOpen size={14} />
          </button>
        )}

        {(selectedBranch || selectedLeaf) && (
          <div className="shrink-0 flex items-center gap-2 text-[11px] text-slate-500 mb-2 min-w-0">
            {scopeTree && (
              <button onClick={() => setSelected({ kind: 'tree', id: scopeTree.id })} className="hover:text-slate-300 truncate">
                {scopeTree.name}
              </button>
            )}
            {scopeTree && <ChevronRight size={11} className="shrink-0" />}
            {selectedLeaf ? (
              <>
                <button
                  onClick={() => setSelected({ kind: 'branch', id: selectedLeaf.branchId })}
                  className="hover:text-slate-300 truncate"
                >
                  {branchRecords.find((b) => b.id === selectedLeaf.branchId)?.title ?? 'conversation'}
                </button>
                <ChevronRight size={11} className="shrink-0" />
                <span className="text-slate-400 truncate">{selectedLeaf.title}</span>
              </>
            ) : (
              <span className="text-slate-400 truncate">{selectedBranch?.title}</span>
            )}
          </div>
        )}

        {selectedLeaf ? (
          <div className="overflow-y-auto pr-2">
            <LeafDetail
              leaf={selectedLeaf}
              subLeaves={childrenOf(selectedLeaf.id)}
              all={all}
              onReview={(branchId) => setSelected({ kind: 'branch', id: branchId })}
            />
          </div>
        ) : selectedBranch ? (
          <BranchChat
            branchId={selectedBranch.id}
            record={selectedBranch}
            leaves={all}
            messages={
              transcripts[selectedBranch.id]
              ?? overlayBranchMessages(selectedBranch.messages ?? [], liveTurns[branchTurnKey(selectedBranch.id)])
            }
            onMessagesChange={(next) =>
              setTranscripts((t) => ({
                ...t,
                [selectedBranch.id]: typeof next === 'function' ? next(t[selectedBranch.id] ?? []) : next,
              }))
            }
            mode={modes[selectedBranch.id] ?? 'auto'}
            onModeChange={(m) => setModes((all) => ({ ...all, [selectedBranch.id]: m }))}
            onProposals={refresh}
            onAccept={(id) => accept.mutate(id)}
            onSetAcceptance={async (commands) => {
              await patchBranch(selectedBranch.id, { acceptance: commands });
              setAcceptError(null);
              refresh();
            }}
            onReject={(id) => reject.mutate(id)}
            onAcceptAll={(ids) => acceptAll.mutate(ids)}
            {...(handoff && handoff.branchId === selectedBranch.id
              ? { autoSend: handoff.prompt, ...(onHandoffTaken ? { onAutoSent: onHandoffTaken } : {}) }
              : opening && opening.branchId === selectedBranch.id
                ? { autoSend: opening.prompt, onAutoSent: () => setOpening(undefined) }
                : {})}
          />
        ) : (
          <Home
            leaves={all}
            branches={branchRecords}
            trees={trees}
            {...(projectTree ? { tree: projectTree } : {})}
            lastSeen={seenAt.current}
            onOpenBranch={(id) => setSelected({ kind: 'branch', id })}
            packNames={Object.fromEntries(packs.map((p) => [p.id, p.name]))}
            starting={startWork.isPending}
            onStart={(treeId, prompt) => startWork.mutate({ treeId, prompt })}
            onOpenLeaf={(leaf) => {
              const record = branchRecords.find((b) => b.id === leaf.branchId);
              if (record?.treeId) setOpenTree(record.treeId);
              setSelected({ kind: 'leaf', id: leaf.id });
            }}
            onOpenTree={(id) => { setOpenTree(id); setSelected({ kind: 'tree', id }); }}
          />
        )}
      </section>

      {newTree && (
        <NewTreeDialog
          onClose={() => setNewTree(false)}
          onCreated={(id) => { if (id) { setOpenTree(id); setSelected({ kind: 'tree', id }); } }}
        />
      )}
    </div>
  );
}
