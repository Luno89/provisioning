import { useState, useMemo, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { useMutation } from '@tanstack/react-query';
import { ChevronRight, ChevronDown, GitBranch, Plus, Loader2, PanelLeftClose, PanelLeftOpen, Trash2 } from 'lucide-react';
import { type Message } from './Chat.js';
import BranchChat, { type BranchRecord } from './BranchChat.js';
import LeafDetail from './LeafDetail.js';
import { STATE_DOT, STATE_LABEL, CANCELLED_DOT, stateFor, type Leaf } from './leaf-types.js';
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

export default function Workspace({ apiBase, handoff, onHandoffTaken, onReview }: {
  apiBase: string;
  /**
   * A conversation to open, with a message to send on arrival.
   *
   * How the board's "review this failure" lands here: it carries the branch AND the evidence, so
   * the user arrives at an answer being written rather than at an empty box they have to describe
   * the failure into.
   */
  handoff?: { branchId: string; prompt: string } | undefined;
  onHandoffTaken?: () => void;
  /**
   * Opens a review of a failed leaf in the conversation.
   *
   * Lifted to the caller because a review is a hand-off to a BRANCH, and the same one serves the
   * board — a failed leaf reached from the sidebar and one reached from a card must not start two
   * different kinds of conversation.
   */
  onReview?: (branchId: string, prompt: string) => void;
}) {
  const qc = useQueryClient();
  // The conversation currently open. Kept client-side: a branch with leaves is recoverable from
  // them, and a brand-new one has nothing worth persisting until it does.
  // Empty until a branch is chosen or created. Branches are server records now, so inventing an
  // id client-side would make one that the server has never heard of.
  const [activeBranch, setActiveBranch] = useState<string>('');
  const [selected, setSelected] = useState<{ kind: 'branch' | 'leaf'; id: string }>(() => ({ kind: 'branch', id: '' }));
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  /**
   * Transcripts, per branch, held here rather than inside Chat.
   *
   * Chat unmounts every time a leaf is selected, so component state lost the whole conversation on
   * a single click. Keyed by branch so switching between conversations keeps both.
   */
  // Local echo of the transcript while a reply streams. The server persists each completed turn,
  // so this is overlaid on what the branch record already holds rather than being the only copy.
  const [transcripts, setTranscripts] = useState<Record<string, Message[]>>({});

  const { data: branchRecords } = useQuery<BranchRecord[]>({
    queryKey: ['branches'],
    queryFn: () => axios.get(`${apiBase}/branches`, { withCredentials: true }).then((r) => r.data),
    refetchInterval: 10000,
  });

  const { data: leaves, isLoading } = useQuery<Leaf[]>({
    queryKey: ['leaves'],
    queryFn: () => axios.get(`${apiBase}/leaves`, { withCredentials: true }).then((r) => r.data),
    refetchInterval: 5000,
  });

  const all = useMemo(() => leaves ?? [], [leaves]);
  const refreshLeaves = () => {
    qc.invalidateQueries({ queryKey: ['leaves'] });
    // The server persisted the turn and may have titled a new branch from it.
    qc.invalidateQueries({ queryKey: ['branches'] });
  };

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

    // Server records first, so titles come from the branch rather than from whatever its first
    // leaf happened to be called — which made a branch and its only leaf read identically.
    const nodes = (branchRecords ?? []).map((b) => ({
      id: b.id,
      title: b.title,
      leaves: byBranch.get(b.id) ?? [],
    }));

    // Leaves whose branch record predates this (or was deleted) still need somewhere to live.
    for (const [id, ls] of byBranch) {
      if (!nodes.some((n) => n.id === id)) {
        nodes.push({ id, title: ls.find((l) => !l.parentLeafId)?.title ?? 'Untitled branch', leaves: ls });
      }
    }
    /**
     * Newest first, derived nodes included.
     *
     * The server sorts its records that way, but a derived node was appended AFTER all of them
     * regardless of when its work ran — so a branch reconstructed from leaves landed at the bottom
     * of the list however recent it was. With thirty-odd branches that reads as missing: the thing
     * you just watched run is the one furthest from the top.
     *
     * Sorted on the leaves' own timestamps, since a derived node has no record to take one from.
     */
    const lastTouched = (n: BranchNode) => {
      const record = (branchRecords ?? []).find((b) => b.id === n.id);
      if (record) return record.updatedAt;
      return n.leaves.reduce((newest, l) => (l.updatedAt > newest ? l.updatedAt : newest), '');
    };
    return nodes.sort((a, b) => lastTouched(b).localeCompare(lastTouched(a)));
  }, [all, branchRecords]);

  const childrenOf = (parentId: string) => all.filter((l) => l.parentLeafId === parentId);

  const createBranch = useMutation({
    mutationFn: () => axios.post(`${apiBase}/branches`, {}, { withCredentials: true }).then((r) => r.data),
    onSuccess: (branch: BranchRecord) => {
      setActiveBranch(branch.id);
      setSelected({ kind: 'branch', id: branch.id });
      qc.invalidateQueries({ queryKey: ['branches'] });
    },
  });

  const deleteBranch = useMutation({
    mutationFn: (id: string) => axios.delete(`${apiBase}/branches/${id}`, { withCredentials: true }),
    onSuccess: (_, deletedId) => {
      setTranscripts((prev) => {
        const copy = { ...prev };
        delete copy[deletedId];
        return copy;
      });
      if (activeBranch === deletedId) {
        setActiveBranch('');
        setSelected({ kind: 'branch', id: '' });
      }
      qc.invalidateQueries({ queryKey: ['branches'] });
      qc.invalidateQueries({ queryKey: ['leaves'] });
    },
  });

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
  /**
   * A hand-off selects its branch, once.
   *
   * Keyed on the branch id so arriving from the board a second time re-opens it, but a re-render
   * does not fight whatever the user has selected since.
   */
  const openedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!handoff || openedRef.current === handoff.branchId) return;
    openedRef.current = handoff.branchId;
    setActiveBranch(handoff.branchId);
    setSelected({ kind: 'branch', id: handoff.branchId });
  }, [handoff]);

  const selectedBranch = selected.kind === 'branch' ? (selected.id || activeBranch) : undefined;

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
          {/* Derived, never read off `leaf.column` — that field means one thing from /api/leaves
              and another from the board endpoint. See leaf-types.ts. */}
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
    <div className="flex h-[calc(100vh-7rem)] gap-0">
      {/* ── Tree ── */}
      <aside className={`${sidebarCollapsed ? 'w-0 opacity-0 overflow-hidden pr-0 hidden' : 'w-72 pr-3'} shrink-0 border-r border-[var(--bark-600)] overflow-y-auto transition-all duration-200`}>
        <div className="flex items-center justify-between mb-3 pl-2">
          <h2 className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Branches</h2>
          <div className="flex items-center gap-1">
            <button
              onClick={() => createBranch.mutate()}
              title="Start a new conversation"
              className="text-slate-600 hover:text-slate-300 p-0.5 rounded"
            >
              <Plus size={14} />
            </button>
            <button
              onClick={() => setSidebarCollapsed(true)}
              title="Collapse Branches sidebar"
              className="text-slate-600 hover:text-slate-300 p-0.5 rounded"
            >
              <PanelLeftClose size={14} />
            </button>
          </div>
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
                  className={`group flex items-center gap-1.5 py-1 px-2 rounded-md cursor-pointer text-[13px] ${isSelected ? 'bg-[var(--bark-700)] text-slate-100' : 'text-slate-300 hover:bg-[var(--bark-800)]'}`}
                >
                  <button
                    onClick={(e) => { e.stopPropagation(); setCollapsed((c) => ({ ...c, [branch.id]: !isCollapsed })); }}
                    className="text-slate-600 hover:text-slate-300 shrink-0"
                    title={isCollapsed ? "Expand branch" : "Collapse branch"}
                  >
                    {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                  </button>
                  <GitBranch size={12} className="text-slate-500 shrink-0" />
                  <span className="truncate flex-1 min-w-0">{branch.title}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm(`Delete branch "${branch.title}" and all its leaves?`)) {
                        deleteBranch.mutate(branch.id);
                      }
                    }}
                    title="Delete branch"
                    className="text-slate-500 hover:text-red-400 p-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                  >
                    <Trash2 size={12} />
                  </button>
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
      <section className="flex-1 min-w-0 pl-6 overflow-hidden flex flex-col relative">
        {sidebarCollapsed && (
          <button
            onClick={() => setSidebarCollapsed(false)}
            title="Expand Branches sidebar"
            className="absolute top-0 left-0 z-10 p-1.5 rounded-lg border border-[var(--bark-600)] bg-[var(--bark-900)] text-slate-400 hover:text-slate-200 transition-colors shadow-md"
          >
            <PanelLeftOpen size={14} />
          </button>
        )}
        {selectedLeaf ? (
          <div className="overflow-y-auto pr-2">
            <LeafDetail
              apiBase={apiBase}
              leaf={selectedLeaf}
              subLeaves={childrenOf(selectedLeaf.id)}
              all={all}
              {...(onReview ? { onReview } : {})}
            />
          </div>
        ) : selectedBranch ? (
          /* Assembled by BranchChat, the one place a conversation is put together — Grove opens the
             same conversations, and building them twice is how the two would start to differ. */
          <BranchChat
            apiBase={apiBase}
            branchId={selectedBranch}
            record={(branchRecords ?? []).find((b) => b.id === selectedBranch)}
            leaves={all}
            messages={
              transcripts[selectedBranch] ??
              (branchRecords ?? []).find((b) => b.id === selectedBranch)?.messages ??
              []
            }
            onMessagesChange={(next) =>
              setTranscripts((t) => ({
                ...t,
                [selectedBranch]: typeof next === 'function' ? next(t[selectedBranch] ?? []) : next,
              }))
            }
            onProposals={refreshLeaves}
            onAccept={(id) => accept.mutate(id)}
            onReject={(id) => reject.mutate(id)}
            onAcceptAll={(ids) => acceptAll.mutate(ids)}
            {...(handoff && handoff.branchId === selectedBranch
              ? { autoSend: handoff.prompt, ...(onHandoffTaken ? { onAutoSent: onHandoffTaken } : {}) }
              : {})}
          />
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
