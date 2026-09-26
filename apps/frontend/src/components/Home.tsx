import { useState, Fragment } from 'react';
import { AlertTriangle, Loader2, ArrowRight, Clock, Sparkles, RotateCcw, ShieldQuestion } from 'lucide-react';
import { needsYou, running, changedSince, treeRollups, scopeToTree, groupWork, ago } from './home-summary.js';
import { STATE_DOT, STATE_LABEL, STATE_STYLE, stateFor, type Leaf } from './leaf-types.js';
import { KoalaSpot } from './Koala.js';

export default function Home({
  leaves, branches, tree, lastSeen, onStart, onOpenLeaf, starting,
}: {
  leaves: Leaf[];
  branches: { id: string; title: string; treeId?: string }[];
  tree: { id: string; name: string; goal?: string };
  lastSeen?: string | undefined;
  onStart: (prompt: string) => void;
  onOpenLeaf: (leaf: Leaf) => void;
  starting?: boolean;
}) {
  const [prompt, setPrompt] = useState('');

  const scoped = scopeToTree(tree.id, branches, leaves);
  const attention = needsYou(scoped.leaves);
  const live = running(scoped.leaves);
  const recent = changedSince(scoped.leaves, lastSeen).slice(0, 6);
  const mine = treeRollups([tree], branches, leaves)[0];

  const shownAbove = new Set(attention.map((a) => a.leaf.id));
  const work = groupWork(scoped.leaves.filter((l) => !shownAbove.has(l.id)));
  const branchOf = (id: string) => branches.find((b) => b.id === id)?.title ?? '';
  const retried = scoped.leaves.filter((l) => (l.attempts?.length ?? 0) > 0).length;

  const submit = () => {
    const text = prompt.trim();
    if (!text) return;
    setPrompt('');
    onStart(text);
  };

  const leafRow = (leaf: Leaf, key?: string) => {
    const state = stateFor(leaf, leaves);
    return (
      <button
        key={key ?? leaf.id}
        onClick={() => onOpenLeaf(leaf)}
        className="w-full text-left flex items-center gap-2.5 px-3 py-1.5 rounded-md hover:bg-[var(--bark-800)] text-[12px] group transition-colors"
      >
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${state ? STATE_DOT[state] : 'bg-slate-700'}`} />
        <span className="text-slate-300 truncate flex-1">{leaf.title}</span>
        {(leaf.attempts?.length ?? 0) > 0 && (
          <span className="text-amber-400/70 shrink-0">retried {leaf.attempts!.length}×</span>
        )}
        <span className="text-slate-500 shrink-0 w-16 text-right">{ago(leaf.updatedAt)}</span>
      </button>
    );
  };

  return (
    <div className="max-w-4xl mx-auto py-6 space-y-6 overflow-y-auto h-full pr-2">
      <section>
        <div className="flex items-center gap-2.5 mb-1">
          <KoalaSpot size={28} mood="happy" />
          <h2 className="text-lg font-bold truncate text-slate-100">{tree.name}</h2>
        </div>
        {tree.goal ? <p className="text-xs text-slate-400 mb-3 ml-9">{tree.goal}</p> : <div className="mb-3" />}

        <div className="rounded-lg border border-[var(--bark-700)] bg-[var(--bark-900)]/60 p-3 shadow-xs">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); }}
            rows={3}
            placeholder={`Ask for more work on ${tree.name}, or ask about what is already there.`}
            className="w-full bg-transparent text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none resize-none leading-relaxed"
          />
          <div className="flex items-center gap-2 pt-2 border-t border-[var(--bark-800)]">
            <button
              onClick={submit}
              disabled={!prompt.trim() || starting}
              className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40 shadow-xs transition-colors"
            >
              {starting ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />} Start
            </button>
          </div>
        </div>
      </section>

      {mine && mine.total > 0 && (
        <section className="rounded-lg border border-[var(--bark-800)] bg-[var(--bark-900)]/40 p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-slate-400">
            <span>{scoped.branches.length} {scoped.branches.length === 1 ? 'branch' : 'branches'}, {scoped.leaves.length} {scoped.leaves.length === 1 ? 'leaf' : 'leaves'}</span>
            {retried > 0 && (
              <span className="flex items-center gap-1.5 text-amber-400/80" title="Leaves that were retried after failing">
                <RotateCcw size={13} /> {retried} retried
              </span>
            )}
          </div>
          <div className="flex h-1.5 rounded-full overflow-hidden bg-[var(--bark-700)]">
            <div className="bg-[var(--leaf)]" style={{ width: `${(mine.verified / mine.total) * 100}%` }} title={`${mine.verified} verified`} />
            <div className="bg-amber-500/70" style={{ width: `${(mine.claimed / mine.total) * 100}%` }} title={`${mine.claimed} claimed but unchecked`} />
          </div>
          <div className="flex gap-4 text-[11px] text-slate-500 font-mono">
            <span className="text-[var(--leaf)]">{mine.verified} verified</span>
            <span className="text-amber-500">{mine.claimed} claimed</span>
            <span>{mine.outstanding} left</span>
          </div>
        </section>
      )}

      {attention.length > 0 && (
        <section>
          <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-2 flex items-center gap-1.5">
            <AlertTriangle size={11} className="text-amber-400" /> Needs you · {attention.length}
          </h3>
          <div className="space-y-1.5">
            {attention.map(({ leaf, reason }) => {
              const attempts = leaf.attempts?.length ?? 0;
              return (
                <button
                  key={leaf.id}
                  onClick={() => onOpenLeaf(leaf)}
                  className={`w-full text-left flex items-center gap-3 px-3 py-2 rounded-md border transition-colors ${
                    reason === 'failed'
                      ? 'border-rose-500/30 bg-rose-950/10 hover:border-rose-500/50'
                      : 'border-[var(--bark-700)] bg-[var(--bark-900)]/40 hover:border-[var(--bark-600)]'
                  }`}
                >
                  {reason === 'failed'
                    ? <AlertTriangle size={14} className="text-rose-400 shrink-0" />
                    : <ShieldQuestion size={14} className="text-amber-400 shrink-0" />}
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-slate-200 truncate">{leaf.title}</div>
                    <div className="text-[11px] text-slate-500 truncate">
                      {reason === 'failed'
                        ? `failed${attempts > 0 ? ` after ${attempts + 1} attempts` : ''} · ${branchOf(leaf.branchId)}`
                        : `the judge could not settle the claim — read the evidence · ${branchOf(leaf.branchId)}`}
                    </div>
                  </div>
                  <span className="text-[11px] text-slate-500 shrink-0">{reason === 'failed' ? 'retry' : 'judge'}</span>
                  <ArrowRight size={13} className="text-slate-600 shrink-0" />
                </button>
              );
            })}
          </div>
        </section>
      )}

      <section>
        <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-2">Running</h3>
        {live.length === 0 ? (
          <p className="text-xs text-slate-500">Nothing is running.</p>
        ) : (
          <div className="space-y-1.5">
            {live.map((leaf) => (
              <button
                key={leaf.id}
                onClick={() => onOpenLeaf(leaf)}
                className="w-full text-left flex items-center gap-3 px-3 py-2 rounded-md border border-[var(--bark-700)] bg-[var(--bark-900)]/40 hover:border-[var(--bark-600)] transition-colors"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-slate-200 truncate">{leaf.title}</div>
                  <div className="text-[11px] text-slate-500 truncate">
                    in a sandbox · started {ago(leaf.updatedAt)} · {branchOf(leaf.branchId)}
                  </div>
                </div>
                <ArrowRight size={13} className="text-slate-600 shrink-0" />
              </button>
            ))}
          </div>
        )}
      </section>

      {recent.length > 0 && (
        <section>
          <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-2 flex items-center gap-1.5">
            <Clock size={11} /> Since you last looked
          </h3>
          <div className="space-y-0.5">{recent.map((l) => leafRow(l, `recent-${l.id}`))}</div>
        </section>
      )}

      {work.length > 0 && (
        <section>
          <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-2">The work</h3>
          <div className="space-y-4">
            {work.map((group) => (
              <Fragment key={group.state}>
                <div>
                  <div className={`text-[11px] font-black uppercase tracking-widest mb-1 px-3 ${STATE_STYLE[group.state]}`}>
                    {STATE_LABEL[group.state]} · {group.leaves.length}
                  </div>
                  <div className="space-y-0.5">{group.leaves.map((l) => leafRow(l, `work-${l.id}`))}</div>
                </div>
              </Fragment>
            ))}
          </div>
        </section>
      )}

    </div>
  );
}
