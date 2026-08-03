import { useState, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { useMutation } from '@tanstack/react-query';
import { ChevronRight, ChevronDown, GitBranch, Plus, Loader2 } from 'lucide-react';
import Chat, { type Message } from './Chat.js';
import LeafDetail from './LeafDetail.js';
import { STATUS_DOT, type Leaf } from './leaf-types.js';
import { KoalaSpot } from './Koala.js';



/**
 * The harness — a tree on the left, the selected thing on the right.
 *
 * A tree rather than columns because decomposition is a SHAPE, and that is what the board is for:
 * seeing how the agent broke the work up. Columns only ever showed state, which is one attribute
 * of a leaf and not the interesting one.
 *
 * Selecting a branch shows its conversation; selecting a leaf shows that leaf. The two are not
 * bound to each other — you can talk without growing anything, and a leaf can be discussed without
 * being the subject of the chat.
 */

interface BranchNode {
  id: string;
  title: string;
  leaves: Leaf[];
}

export default function Workspace({ apiBase }: { apiBase: string }) {
  const qc = useQueryClient();
  // The conversation currently open. Kept client-side: a branch with leaves is recoverable from
  // them, and a brand-new one has nothing worth persisting until it does.
  const [activeBranch, setActiveBranch] = useState<string>(() => crypto.randomUUID());
  const [selected, setSelected] = useState<{ kind: 'branch' | 'leaf'; id: string }>(() => ({ kind: 'branch', id: '' }));
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [mode, setMode] = useState<'chat' | 'auto' | 'plan'>('auto');
  /**
   * Transcripts, per branch, held here rather than inside Chat.
   *
   * Chat unmounts every time a leaf is selected, so component state lost the whole conversation on
   * a single click. Keyed by branch so switching between conversations keeps both.
   */
  const [transcripts, setTranscripts] = useState<Record<string, Message[]>>({});

  const { data: leaves, isLoading } = useQuery<Leaf[]>({
    queryKey: ['leaves'],
    queryFn: () => axios.get(`${apiBase}/leaves`, { withCredentials: true }).then((r) => r.data),
    refetchInterval: 5000,
  });

  const all = useMemo(() => leaves ?? [], [leaves]);
  const refreshLeaves = () => qc.invalidateQueries({ queryKey: ['leaves'] });

  /**
   * Branches, derived from the leaves that reference them plus whichever is open.
   *
   * Derived rather than stored: a branch is a conversation, and one that produced nothing has
   * nothing to show in a tree. The active branch is included even when empty so a fresh chat has
   * somewhere to live.
   */
  const branches = useMemo<BranchNode[]>(() => {
    const byBranch = new Map<string, Leaf[]>();
    for (const leaf of all) {
      byBranch.set(leaf.branchId, [...(byBranch.get(leaf.branchId) ?? []), leaf]);
    }
    if (!byBranch.has(activeBranch)) byBranch.set(activeBranch, []);

    return [...byBranch.entries()].map(([id, ls]) => {
      // Named after its first root leaf — the closest thing to a title a derived branch has.
      const root = ls.filter((l) => !l.parentLeafId)[0];
      return { id, title: root?.title ?? 'New branch', leaves: ls };
    });
  }, [all, activeBranch]);

  const childrenOf = (parentId: string) => all.filter((l) => l.parentLeafId === parentId);

  const accept = useMutation({
    mutationFn: (id: string) => axios.post(`${apiBase}/leaves/${id}/accept`, {}, { withCredentials: true }),
    onSuccess: refreshLeaves,
  });
  const reject = useMutation({
    mutationFn: (id: string) => axios.delete(`${apiBase}/leaves/${id}`, { withCredentials: true }),
    onSuccess: refreshLeaves,
  });
  const acceptAll = useMutation({
    // Sequential, not parallel: each accept re-checks the branch budget, and firing them at once
    // would let several slip through a ceiling that only had room for one.
    mutationFn: async (ids: string[]) => {
      for (const id of ids) {
        await axios.post(`${apiBase}/leaves/${id}/accept`, {}, { withCredentials: true }).catch(() => {});
      }
    },
    onSuccess: refreshLeaves,
  });
  const selectedLeaf = selected.kind === 'leaf' ? all.find((l) => l.id === selected.id) : undefined;
  // An empty branch selection means "the open conversation", so a fresh session lands somewhere.
  const selectedBranch = selected.kind === 'branch' ? (selected.id || activeBranch) : undefined;

  const renderLeaf = (leaf: Leaf, depth: number) => {
    const kids = childrenOf(leaf.id);
    const isCollapsed = collapsed[leaf.id] ?? false;
    const isSelected = selected.kind === 'leaf' && selected.id === leaf.id;

    return (
      <div key={leaf.id}>
        <div
          onClick={() => setSelected({ kind: 'leaf', id: leaf.id })}
          className={`flex items-center gap-1.5 py-1 pr-2 rounded-md cursor-pointer text-[13px] ${isSelected ? 'bg-[var(--bark-700)] text-slate-100' : 'text-slate-400 hover:bg-[var(--bark-800)]'}`}
          style={{ paddingLeft: `${depth * 14 + 8}px` }}
        >
          {kids.length > 0 ? (
            <button
              onClick={(e) => { e.stopPropagation(); setCollapsed((c) => ({ ...c, [leaf.id]: !isCollapsed })); }}
              className="text-slate-600 hover:text-slate-300 shrink-0"
            >
              {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
            </button>
          ) : (
            <span className="w-3 shrink-0" />
          )}
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[leaf.status]}`} title={leaf.status} />
          <span className="truncate">{leaf.title}</span>
          {kids.length > 0 && <span className="text-[10px] text-slate-600 shrink-0">{kids.length}</span>}
        </div>
        {!isCollapsed && kids.map((k) => renderLeaf(k, depth + 1))}
      </div>
    );
  };

  return (
    <div className="flex h-[calc(100vh-7rem)] gap-0">
      {/* ── Tree ── */}
      <aside className="w-72 shrink-0 border-r border-[var(--bark-600)] pr-3 overflow-y-auto">
        <div className="flex items-center justify-between mb-3 pl-2">
          <h2 className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Branches</h2>
          <button
            onClick={() => {
              const id = crypto.randomUUID();
              setActiveBranch(id);
              setSelected({ kind: 'branch', id });
            }}
            title="Start a new conversation"
            className="text-slate-600 hover:text-slate-300"
          >
            <Plus size={14} />
          </button>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 text-slate-500 text-xs pl-2"><Loader2 className="animate-spin" size={12} /> Loading…</div>
        ) : (
          branches.map((branch) => {
            const roots = branch.leaves.filter((l) => !l.parentLeafId);
            const isCollapsed = collapsed[branch.id] ?? false;
            const isSelected = selected.kind === 'branch' && (selected.id || activeBranch) === branch.id;
            return (
              <div key={branch.id} className="mb-1">
                <div
                  onClick={() => { setActiveBranch(branch.id); setSelected({ kind: 'branch', id: branch.id }); }}
                  className={`flex items-center gap-1.5 py-1 px-2 rounded-md cursor-pointer text-[13px] ${isSelected ? 'bg-[var(--bark-700)] text-slate-100' : 'text-slate-300 hover:bg-[var(--bark-800)]'}`}
                >
                  {roots.length > 0 ? (
                    <button
                      onClick={(e) => { e.stopPropagation(); setCollapsed((c) => ({ ...c, [branch.id]: !isCollapsed })); }}
                      className="text-slate-600 hover:text-slate-300 shrink-0"
                    >
                      {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                    </button>
                  ) : (
                    <span className="w-3 shrink-0" />
                  )}
                  <GitBranch size={12} className="text-slate-500 shrink-0" />
                  <span className="truncate">{branch.title}</span>
                </div>
                {!isCollapsed && roots.map((l) => renderLeaf(l, 1))}
              </div>
            );
          })
        )}
      </aside>

      {/* ── Detail ── */}
      {/* overflow-hidden, not auto: the chat manages its own transcript scrolling, and a scrolling
          parent around a scrolling child is what produced two scrollbars. Leaf detail opts back in. */}
      <section className="flex-1 min-w-0 pl-6 overflow-hidden flex flex-col">
        {selectedLeaf ? (
          <div className="overflow-y-auto"><LeafDetail apiBase={apiBase} leaf={selectedLeaf} subLeaves={childrenOf(selectedLeaf.id)} /></div>
        ) : selectedBranch ? (
          <div className="flex flex-col h-full min-h-0">

            <div className="flex-1 min-h-0">
              {/* Keyed on the branch so switching conversations resets the transcript rather than
                  carrying one branch's messages into another. */}
              {/* Keyed on the branch only — changing mode mid-conversation must not wipe the
                  transcript, since the whole point is switching as the conversation changes shape. */}
              {(() => {
                const proposed = all
                  .filter((l) => l.branchId === selectedBranch && l.status === 'proposed')
                  .map((l) => ({ id: l.id, title: l.title, ...(l.body ? { body: l.body } : {}) }));
                return (
                  <Chat
                    // No key on the branch any more: remounting is what discarded the transcript.
                    // The parent holds it per branch instead.
                    apiBase={apiBase}
                    branchId={selectedBranch}
                    mode={mode}
                    onModeChange={setMode}
                    onProposals={refreshLeaves}
                    messages={transcripts[selectedBranch] ?? []}
                    onMessagesChange={(next) =>
                      setTranscripts((t) => ({
                        ...t,
                        [selectedBranch]: typeof next === 'function' ? next(t[selectedBranch] ?? []) : next,
                      }))
                    }
                    proposed={proposed}
                    onAccept={(id) => accept.mutate(id)}
                    onReject={(id) => reject.mutate(id)}
                    onAcceptAll={() => acceptAll.mutate(proposed.map((p) => p.id))}
                  />
                );
              })()}
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <KoalaSpot size={72} mood="idle" className="sway opacity-60" />
            <p className="text-slate-600 text-sm">Select a branch or leaf.</p>
          </div>
        )}
      </section>
    </div>
  );
}
