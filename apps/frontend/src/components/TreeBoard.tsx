import { useState, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { ArrowLeft, Loader2, GitBranch, Coins, RotateCcw, ShieldCheck, ShieldQuestion, Clock } from 'lucide-react';
import LeafTrace from './LeafTrace.js';

/**
 * One tree's board — what has been done and what is left.
 *
 * ── WHY THIS IS NOT THE WORKSPACE TREE ──
 * Workspace.tsx shows the SHAPE of one request: how the agent broke a conversation up. That is the
 * right view at that altitude and it deliberately refuses columns. This is a different question at
 * a different altitude — a tree spans many conversations, and "is this project delivering" cannot
 * be read off any single one of them. Drilling in hands back to the request view.
 *
 * ── WHY CLAIMED AND VERIFIED ARE SEPARATE COLUMNS ──
 * The one design decision worth defending. A normal board's "Done" is the sum of everything that
 * finished, but half of what finishes here is a model's report on its own work. `verified` means a
 * check actually ran. Putting both under one green heading would launder a claim into a fact at the
 * exact point a person looks, which is what lib/leaf-verify.ts exists to prevent.
 *
 * ── AND WHY IT SAYS WHAT CHANGED ──
 * A Jira board moves when somebody drags a card. This one moves while nobody is watching — leaves
 * are proposed, started and finished by the system, overnight. A static snapshot is the wrong
 * metaphor, so the board reports what happened since you last had it open.
 */

interface BoardLeaf {
  id: string;
  branchId: string;
  title: string;
  status: string;
  column?: 'proposed' | 'blocked' | 'running' | 'claimed' | 'verified' | 'failed';
  personaId?: string;
  verified?: boolean;
  merged?: boolean;
  tokens: number;
  attempts: number;
  waitingOn: { id: string; title: string }[];
  outputBranch?: string;
  updatedAt: string;
}

interface Board {
  tree: { id: string; name: string; type: string; goal?: string };
  rollup: {
    counts: Record<string, number>;
    outstanding: number;
    tokens: number;
    retried: number;
    branches: number;
  };
  changed: number;
  repos: { id: string; name: string; owner: string; repo: string }[];
  branches: { id: string; title: string; acceptanceOutcome?: string; updatedAt: string }[];
  leaves: BoardLeaf[];
}

const COLUMNS: { id: string; label: string; hint: string }[] = [
  { id: 'proposed', label: 'To do', hint: 'Waiting to start' },
  { id: 'blocked', label: 'Blocked', hint: 'Waiting on other work' },
  { id: 'running', label: 'Running', hint: 'In a sandbox now' },
  { id: 'claimed', label: 'Claimed', hint: 'The agent says it worked. Nothing checked it.' },
  { id: 'verified', label: 'Verified', hint: 'A check ran and passed' },
  { id: 'failed', label: 'Failed', hint: 'Still owed' },
];

const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export default function TreeBoard({
  apiBase, treeId, personaNames, onBack, onReview,
}: {
  apiBase: string;
  treeId: string;
  personaNames: Record<string, string>;
  onBack: () => void;
  /** Hands a failed leaf's evidence to Koala, which is where a review is actually discussed. */
  onReview?: (branchId: string, prompt: string) => void;
}) {
  const [openLeaf, setOpenLeaf] = useState<BoardLeaf | null>(null);

  /**
   * When this board was last looked at.
   *
   * A ref rather than state: it must NOT change while the board is open, or every poll would move
   * the baseline forward and "what changed" would permanently read zero — which is exactly the
   * failure that makes a live board indistinguishable from a dead one.
   */
  const since = useRef<string | undefined>(localStorage.getItem(`tree-seen-${treeId}`) ?? undefined);

  const { data, isLoading } = useQuery<Board>({
    queryKey: ['tree-board', treeId],
    queryFn: () => axios
      .get(`${apiBase}/trees/${treeId}/board`, {
        params: since.current ? { since: since.current } : {},
        withCredentials: true,
      })
      .then((r) => r.data),
    // Work starts and finishes without anybody clicking, so the board refreshes itself.
    refetchInterval: 5000,
  });

  // Written on unmount, not on render: marking it seen while you are still reading it would
  // discard the very thing the marker is for.
  useEffect(() => () => { localStorage.setItem(`tree-seen-${treeId}`, new Date().toISOString()); }, [treeId]);

  if (isLoading || !data) {
    return <div className="p-8 text-slate-500 flex items-center gap-2"><Loader2 className="animate-spin" size={18} /> Loading board…</div>;
  }

  const { rollup, leaves } = data;
  const done = rollup.counts.verified ?? 0;
  const claimed = rollup.counts.claimed ?? 0;
  const total = done + claimed + rollup.outstanding;
  const branchTitle = (id: string) => data.branches.find((b) => b.id === id)?.title ?? 'unfiled';

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="p-2 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-[var(--bark-700)]">
          <ArrowLeft size={18} />
        </button>
        <div className="min-w-0">
          <h2 className="text-2xl font-bold truncate">{data.tree.name}</h2>
          {data.tree.goal && <p className="text-[13px] text-slate-400 truncate">{data.tree.goal}</p>}
        </div>
      </div>

      <div className="bg-[var(--bark-800)] border border-[var(--bark-600)] rounded-2xl p-5 space-y-3">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[12px] text-slate-400">
          {data.repos.map((r) => (
            <span key={r.id} className="flex items-center gap-1.5 text-slate-300">
              <GitBranch size={13} /> {r.repo}
            </span>
          ))}
          <span className="flex items-center gap-1.5"><Coins size={13} /> {tokens(rollup.tokens)} tokens</span>
          <span>{rollup.branches} {rollup.branches === 1 ? 'conversation' : 'conversations'}</span>
          {rollup.retried > 0 && (
            <span className="flex items-center gap-1.5 text-amber-400/80" title="Leaves that needed more than one attempt">
              <RotateCcw size={13} /> {rollup.retried} retried
            </span>
          )}
          {data.changed > 0 && (
            <span className="ml-auto text-[var(--leaf)] font-semibold">
              {data.changed} {data.changed === 1 ? 'change' : 'changes'} since you last looked
            </span>
          )}
        </div>

        {/**
          * Two bars, never one.
          *
          * Adding verified and claimed into a single "done" figure is the flattening this whole
          * board is arranged to avoid — see the header comment.
          */}
        <div className="flex h-2.5 rounded-full overflow-hidden bg-[var(--bark-700)]">
          {total > 0 && (
            <>
              <div className="bg-[var(--leaf)]" style={{ width: `${(done / total) * 100}%` }} title={`${done} verified`} />
              <div className="bg-amber-500/70" style={{ width: `${(claimed / total) * 100}%` }} title={`${claimed} claimed but unchecked`} />
            </>
          )}
        </div>
        <div className="flex gap-4 text-[11px] text-slate-500">
          <span className="flex items-center gap-1.5"><ShieldCheck size={12} className="text-[var(--leaf)]" /> {done} verified</span>
          <span className="flex items-center gap-1.5"><ShieldQuestion size={12} className="text-amber-500" /> {claimed} claimed</span>
          <span className="flex items-center gap-1.5"><Clock size={12} /> {rollup.outstanding} left</span>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
        {COLUMNS.map((col) => {
          const cards = leaves.filter((l) => l.column === col.id);
          return (
            <div key={col.id} className="min-w-0">
              <div className="flex items-baseline gap-2 mb-2 px-1" title={col.hint}>
                <span className="text-[11px] font-black uppercase tracking-widest text-slate-400">{col.label}</span>
                <span className="text-[11px] text-slate-600">{cards.length}</span>
              </div>
              <div className="space-y-2">
                {cards.map((leaf) => (
                  <button
                    key={leaf.id}
                    onClick={() => setOpenLeaf(leaf)}
                    className={`w-full text-left bg-[var(--bark-800)] border rounded-xl p-3 space-y-2 hover:border-[var(--bark-500)] ${
                      leaf.column === 'failed' ? 'border-red-500/40' : 'border-[var(--bark-600)]'
                    }`}
                  >
                    <p className="text-[13px] leading-snug text-slate-200">{leaf.title}</p>

                    {leaf.waitingOn.length > 0 && (
                      // Named rather than counted: "waiting on the transport leaf" is actionable
                      // where "blocked" is not.
                      <p className="text-[11px] text-slate-500 truncate">
                        waits on {leaf.waitingOn.map((w) => w.title).join(', ')}
                      </p>
                    )}

                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-slate-500">
                      {leaf.personaId && <span className="text-slate-400">{personaNames[leaf.personaId] ?? 'persona'}</span>}
                      {leaf.tokens > 0 && <span>{tokens(leaf.tokens)}</span>}
                      {leaf.attempts > 1 && <span className="text-amber-400/80">{leaf.attempts} attempts</span>}
                      {leaf.column === 'claimed' && <span className="text-amber-400/80">unchecked</span>}
                      {leaf.merged && <span className="text-[var(--leaf)]">merged</span>}
                    </div>

                    <p className="text-[10px] text-slate-600 truncate">{branchTitle(leaf.branchId)}</p>
                  </button>
                ))}
                {cards.length === 0 && <div className="text-[11px] text-slate-700 px-1">—</div>}
              </div>
            </div>
          );
        })}
      </div>

      {openLeaf && (
        <LeafTrace
          apiBase={apiBase}
          leaf={openLeaf}
          personaName={openLeaf.personaId ? personaNames[openLeaf.personaId] : undefined}
          onClose={() => setOpenLeaf(null)}
          {...(onReview ? { onReview } : {})}
        />
      )}
    </div>
  );
}
