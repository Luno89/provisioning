import { useState, useMemo, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import {
  ChevronRight, ChevronDown, GitBranch, Plus, Loader2,
  PanelLeftClose, PanelLeftOpen, Trash2, Trees as TreesIcon, Inbox,
} from 'lucide-react';
import BranchChat, { type BranchRecord } from './BranchChat.js';
import Home from './Home.js';
import NewTreeDialog from './NewTreeDialog.js';
import TreeBoard from './TreeBoard.js';
import LeafDetail from './LeafDetail.js';
import { STATE_DOT, STATE_LABEL, CANCELLED_DOT, stateFor, type Leaf } from './leaf-types.js';
import { type Message } from './Chat.js';
import { parseHash, formatHash, shouldReplace } from '../lib/route.js';
import { lastSeen, markSeenAfterDwell } from '../lib/seen.js';

/**
 * The harness, arranged the way its data actually is.
 *
 * ── WHY THIS REPLACES FOUR SIBLING VIEWS ──
 * Koala's model is Tree → Branch → Leaf, and the interface presented four TOP-LEVEL views that each
 * entered that hierarchy at a different depth and shared no context:
 *
 *   Koala    — entered at Branch, listing every branch of every tree, flat
 *   Trees    — entered at Tree, then replaced itself with a board
 *   Personas — entered nowhere; a global list
 *   Lab      — entered nowhere; filed under infrastructure, two levels deep
 *
 * The consequence was that the tree — which owns the repository, the memory and the definition of
 * done — was invisible from the place you spend all your time, and the conversation, the only place
 * you can direct work, was unreachable from the board except through a bespoke hand-off.
 *
 * ── SO THERE IS ONE NAVIGATOR ──
 * It renders the three levels the data already has. Picking a tree scopes everything to its right;
 * picking a branch opens that conversation; picking a leaf opens that leaf. Nothing is a separate
 * destination any more, which is what dissolves the flat branch wall: two conversations under one
 * tree used to look like accidental duplicates of each other, because nothing said they were
 * siblings.
 */

interface Tree {
  id: string;
  name: string;
  type: string;
  goal?: string;
  branchCount: number;
  updatedAt: string;
}

/** Branches with no tree are real and must not be hidden — see the Unfiled group below. */
const UNFILED = '__unfiled__';

export default function Grove({ apiBase, handoff, onHandoffTaken }: {
  apiBase: string;
  handoff?: { branchId: string; prompt: string } | undefined;
  onHandoffTaken?: () => void;
}) {
  const qc = useQueryClient();

  /**
   * What is open, and what is selected inside it.
   *
   * The tree persists across reloads because it is a SCOPE rather than a click — coming back to the
   * project you were in is the default anyone expects, and losing it was one of the costs of having
   * no routing at all.
   */
  const fromUrl = parseHash(window.location.hash);
  const urlPath = fromUrl?.view === 'grove' ? fromUrl.path : [];
  const [openTree, setOpenTree] = useState<string>(() => urlPath[0] ?? localStorage.getItem('grove-tree') ?? '');
  const [selected, setSelected] = useState<{ kind: 'tree' | 'branch' | 'leaf'; id: string }>(() => {
    // Deepest wins: a link to a leaf opens that leaf, not the tree containing it.
    if (urlPath[2]) return { kind: 'leaf', id: urlPath[2] };
    if (urlPath[1]) return { kind: 'branch', id: urlPath[1] };
    return { kind: 'tree', id: urlPath[0] ?? localStorage.getItem('grove-tree') ?? '' };
  });

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [railClosed, setRailClosed] = useState(false);
  const [newTree, setNewTree] = useState(false);
  const [transcripts, setTranscripts] = useState<Record<string, Message[]>>({});
  /**
   * The opening message for a conversation started from the home page.
   *
   * Held here rather than passed straight through because the branch does not exist yet when the
   * text is typed — it is created first, and this is what gets sent the moment it does.
   */
  const [opening, setOpening] = useState<{ branchId: string; prompt: string } | undefined>();

  /**
   * When this page was last looked at.
   *
   * Read through `lastSeen` rather than straight from localStorage, and stamped after a dwell
   * rather than on unmount — under StrictMode an unmount cleanup fires immediately, which marked
   * the page seen before anything had been read. See lib/seen.ts.
   */
  const seenAt = useRef<string | undefined>(lastSeen('grove-seen'));
  useEffect(() => markSeenAfterDwell('grove-seen'), []);

  useEffect(() => {
    if (openTree) localStorage.setItem('grove-tree', openTree);
  }, [openTree]);

  const { data: trees = [] } = useQuery<Tree[]>({
    queryKey: ['trees'],
    queryFn: () => axios.get(`${apiBase}/trees`, { withCredentials: true }).then((r) => r.data),
  });
  const { data: branchRecords = [] } = useQuery<BranchRecord[]>({
    queryKey: ['branches'],
    queryFn: () => axios.get(`${apiBase}/branches`, { withCredentials: true }).then((r) => r.data),
    refetchInterval: 10000,
  });
  const { data: leaves, isLoading } = useQuery<Leaf[]>({
    queryKey: ['leaves'],
    queryFn: () => axios.get(`${apiBase}/leaves`, { withCredentials: true }).then((r) => r.data),
    refetchInterval: 5000,
  });
  const { data: personas = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ['personas'],
    queryFn: () => axios.get(`${apiBase}/personas`, { withCredentials: true }).then((r) => r.data),
    staleTime: 60_000,
  });

  const all = useMemo(() => leaves ?? [], [leaves]);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['leaves'] });
    qc.invalidateQueries({ queryKey: ['branches'] });
  };

  /** Branches grouped under their tree, with the unfiled ones kept rather than dropped. */
  const groups = useMemo(() => {
    const leavesAll = leaves ?? [];
    const out = trees.map((t) => ({
      id: t.id,
      name: t.name,
      goal: t.goal,
      branches: branchRecords.filter((b) => b.treeId === t.id),
    }));
    const orphans = branchRecords.filter((b) => !b.treeId || !trees.some((t) => t.id === b.treeId));

    /**
     * Leaves whose branch record is gone still need somewhere to live.
     *
     * Grouping strictly by branch RECORD dropped them from the navigator entirely — work that
     * exists, cost tokens and may have shipped, invisible because a conversation was deleted out
     * from under it. Workspace showed them; losing that in the move would have been a regression.
     */
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
      // A dangling treeId lands here too: a branch pointing at a deleted tree is unfiled in every
      // sense that matters, and hiding it would lose the conversation.
      out.push({ id: UNFILED, name: 'Unfiled', goal: 'Conversations not filed under a tree', branches: orphans });
    }
    return out;
  }, [trees, branchRecords, leaves]);

  const leavesOf = (branchId: string) => all.filter((l) => l.branchId === branchId && !l.parentLeafId);
  const childrenOf = (leafId: string) => all.filter((l) => l.parentLeafId === leafId);

  const createBranch = useMutation({
    mutationFn: (treeId: string) => axios
      .post(`${apiBase}/branches`, treeId && treeId !== UNFILED ? { treeId } : {}, { withCredentials: true })
      .then((r) => r.data),
    onSuccess: (branch: BranchRecord) => {
      setSelected({ kind: 'branch', id: branch.id });
      qc.invalidateQueries({ queryKey: ['branches'] });
    },
  });

  const startWork = useMutation({
    mutationFn: ({ treeId }: { treeId: string; prompt: string }) => axios
      .post(`${apiBase}/branches`, treeId && treeId !== UNFILED ? { treeId } : {}, { withCredentials: true })
      .then((r) => r.data as BranchRecord),
    onSuccess: (branch, { treeId, prompt }) => {
      setOpenTree(treeId);
      setSelected({ kind: 'branch', id: branch.id });
      setOpening({ branchId: branch.id, prompt });
      qc.invalidateQueries({ queryKey: ['branches'] });
    },
  });
  const deleteTree = useMutation({
    mutationFn: (id: string) => axios.delete(`${apiBase}/trees/${id}`, { withCredentials: true }),
    onSuccess: (_, id) => {
      if (openTree === id) { setOpenTree(''); setSelected({ kind: 'tree', id: '' }); }
      qc.invalidateQueries({ queryKey: ['trees'] });
      // The conversations survive un-filed, so they move to the Unfiled group.
      qc.invalidateQueries({ queryKey: ['branches'] });
    },
  });

  const deleteBranch = useMutation({
    mutationFn: (id: string) => axios.delete(`${apiBase}/branches/${id}`, { withCredentials: true }),
    onSuccess: (_, id) => {
      setTranscripts((prev) => { const copy = { ...prev }; delete copy[id]; return copy; });
      if (selected.kind === 'branch' && selected.id === id) setSelected({ kind: 'tree', id: openTree });
      refresh();
    },
  });
  const accept = useMutation({
    mutationFn: (id: string) => axios.post(`${apiBase}/leaves/${id}/accept`, {}, { withCredentials: true }),
    onSuccess: refresh,
  });
  const reject = useMutation({
    mutationFn: (id: string) => axios.delete(`${apiBase}/leaves/${id}`, { withCredentials: true }),
    onSuccess: refresh,
  });
  const acceptAll = useMutation({
    // Sequential, not parallel: each accept re-checks the branch budget, and firing them at once
    // would let several slip through a ceiling that only had room for one.
    mutationFn: async (ids: string[]) => {
      for (const id of ids) {
        await axios.post(`${apiBase}/leaves/${id}/accept`, {}, { withCredentials: true }).catch(() => {});
      }
    },
    onSuccess: refresh,
  });

  /** A hand-off opens its branch, once — see Workspace for why this is keyed rather than plain. */
  const openedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!handoff || openedRef.current === handoff.branchId) return;
    openedRef.current = handoff.branchId;
    const record = branchRecords.find((b) => b.id === handoff.branchId);
    if (record?.treeId) setOpenTree(record.treeId);
    setSelected({ kind: 'branch', id: handoff.branchId });
  }, [handoff, branchRecords]);

  const selectedLeaf = selected.kind === 'leaf' ? all.find((l) => l.id === selected.id) : undefined;
  /**
   * The conversation that is open.
   *
   * Falls back to a minimal record when the id is selected but no record has arrived. A review
   * handed over from the board names a branch by id, and requiring the record to be loaded first
   * meant the hand-off could land on the home page instead of the conversation — silently dropping
   * the review, which is the one thing that path exists to deliver.
   */
  const selectedBranch = selected.kind === 'branch'
    ? branchRecords.find((b) => b.id === selected.id)
      ?? ({ id: selected.id, title: 'Conversation', messages: [], updatedAt: '' } as BranchRecord)
    : undefined;
  const scopeTree = trees.find((t) => t.id === openTree);

  /**
   * The address of what is open: #/grove/<tree>/<branch>/<leaf>.
   *
   * A leaf carries its BRANCH in the middle segment even though nothing selected it — the segments
   * are positional, so omitting it would shift the leaf id into the branch slot and a shared link
   * would open the wrong thing entirely.
   *
   * Moving within a tree replaces the history entry rather than pushing one: clicking six cards and
   * then wanting out should be one Back press, not six.
   */
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
    <div className="flex h-[calc(100vh-7rem)] gap-0">
      {/* ── Navigator: tree → branch → leaf ── */}
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
                /**
                 * Selecting a tree opens its board. Expanding it does NOT — those were one click,
                 * so reaching for the disclosure triangle threw away whatever you were reading.
                 * The branch rows below always had them separate; this row was the odd one out.
                 */
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
                        className="text-slate-500 hover:text-red-400 p-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
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

      {/* ── Pane ── */}
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

        {/* A breadcrumb rather than a title: it is the only thing that says which tree you are
            inside, which was the whole complaint about the old chat view. */}
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
              apiBase={apiBase}
              leaf={selectedLeaf}
              subLeaves={childrenOf(selectedLeaf.id)}
              all={all}
              onReview={(branchId) => setSelected({ kind: 'branch', id: branchId })}
            />
          </div>
        ) : selectedBranch ? (
          <BranchChat
            apiBase={apiBase}
            branchId={selectedBranch.id}
            record={selectedBranch}
            leaves={all}
            messages={transcripts[selectedBranch.id] ?? selectedBranch.messages ?? []}
            onMessagesChange={(next) =>
              setTranscripts((t) => ({
                ...t,
                [selectedBranch.id]: typeof next === 'function' ? next(t[selectedBranch.id] ?? []) : next,
              }))
            }
            onProposals={refresh}
            onAccept={(id) => accept.mutate(id)}
            onReject={(id) => reject.mutate(id)}
            onAcceptAll={(ids) => acceptAll.mutate(ids)}
            {...(handoff && handoff.branchId === selectedBranch.id
              ? { autoSend: handoff.prompt, ...(onHandoffTaken ? { onAutoSent: onHandoffTaken } : {}) }
              : opening && opening.branchId === selectedBranch.id
                // Started from the home page: the first message goes out on arrival, so the box you
                // typed into is the box the work started from.
                ? { autoSend: opening.prompt, onAutoSent: () => setOpening(undefined) }
                : {})}
          />
        ) : selected.kind === 'tree' && selected.id && selected.id !== UNFILED ? (
          /**
           * The board follows what is SELECTED, not what is expanded.
           *
           * Keying it off `openTree` meant the disclosure triangle swapped the pane: reaching over
           * to see a tree's conversations threw away whatever you were reading. Expanding and
           * choosing are different acts and now have different consequences.
           */
          <div className="overflow-y-auto -ml-6">
            <TreeBoard
              apiBase={apiBase}
              treeId={selected.id}
              personaNames={Object.fromEntries(personas.map((p) => [p.id, p.name]))}
              onBack={() => setSelected({ kind: 'tree', id: '' })}
              onReview={(branchId) => setSelected({ kind: 'branch', id: branchId })}
            />
          </div>
        ) : (
          /* The landing. It used to be a koala and the words "Pick a tree, a conversation, or a
             leaf" over about a thousand pixels of nothing. */
          <Home
            leaves={all}
            branches={branchRecords}
            trees={trees}
            lastSeen={seenAt.current}
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
          apiBase={apiBase}
          onClose={() => setNewTree(false)}
          onCreated={(id) => { if (id) { setOpenTree(id); setSelected({ kind: 'tree', id }); } }}
        />
      )}
    </div>
  );
}
