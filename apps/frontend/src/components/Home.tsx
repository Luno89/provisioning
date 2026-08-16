import { useState } from 'react';
import { AlertTriangle, Loader2, Check, ArrowRight, Trees as TreesIcon, Clock, Sparkles } from 'lucide-react';
import { needsYou, running, changedSince, treeRollups, ago } from './home-summary.js';
import { STATE_DOT, STATE_LABEL, stateFor, type Leaf } from './leaf-types.js';
import { KoalaSpot } from './Koala.js';

/**
 * Koala's landing page.
 *
 * ── WHY IT REPLACED A BRANCH LIST ──
 * The harness opened on a list of conversations beside an empty pane reading "Select a branch or
 * leaf" — a navigator with no destination, and about a thousand pixels of nothing. That is the
 * wrong shape for a product that works unattended: the question you arrive with, having been away,
 * is "what happened and what needs me", and a file tree answers neither.
 *
 * ── THE ORDER IS THE ARGUMENT ──
 * Start a thing, because that is the primary verb and it used to be three clicks deep — a tree, a
 * new conversation, then a box. Then what is owed, because unattended work fails unattended. Then
 * what is running, because it is the only thing that moves while you watch. Then what changed since
 * you last looked, because you were not here. Trees are last: they are where you go when nothing
 * above needed you.
 *
 * Nothing here is stored. Every figure is derived from records the platform already writes.
 */
export default function Home({
  leaves, branches, trees, lastSeen, onStart, onOpenLeaf, onOpenTree, starting,
}: {
  leaves: Leaf[];
  branches: { id: string; title: string; treeId?: string }[];
  trees: { id: string; name: string }[];
  /** When this page was last looked at, for "since you were away". */
  lastSeen?: string | undefined;
  onStart: (treeId: string, prompt: string) => void;
  onOpenLeaf: (leaf: Leaf) => void;
  onOpenTree: (treeId: string) => void;
  starting?: boolean;
}) {
  const [prompt, setPrompt] = useState('');
  const [treeId, setTreeId] = useState(() => localStorage.getItem('grove-tree') ?? trees[0]?.id ?? '');

  const attention = needsYou(leaves);
  const live = running(leaves);
  const recent = changedSince(leaves, lastSeen).slice(0, 6);
  const rollups = treeRollups(trees, branches, leaves);
  const branchOf = (id: string) => branches.find((b) => b.id === id)?.title ?? '';

  const submit = () => {
    const text = prompt.trim();
    if (!text || !treeId) return;
    setPrompt('');
    onStart(treeId, text);
  };

  return (
    <div className="max-w-4xl mx-auto py-6 space-y-8 overflow-y-auto h-full pr-2">
      {/* ── Start something ── */}
      <section>
        <div className="flex items-center gap-2.5 mb-3">
          <KoalaSpot size={30} mood="happy" />
          <h2 className="text-xl font-bold">What should Koala build?</h2>
        </div>
        <div className="rounded-2xl border border-[var(--bark-600)] bg-[var(--bark-800)] p-3">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); }}
            rows={3}
            placeholder="Describe what you want made. Koala will break it into leaves and ask before it runs anything."
            className="w-full bg-transparent text-[13px] text-slate-200 placeholder:text-slate-600 focus:outline-none resize-none leading-relaxed"
          />
          <div className="flex items-center gap-2 pt-2 border-t border-[var(--bark-700)]">
            <span className="text-[11px] text-slate-500">in</span>
            {/* The tree is chosen HERE rather than after the fact: a conversation filed under nothing
                is how twenty-seven repositories came to exist with one build between them. */}
            <select
              value={treeId}
              onChange={(e) => setTreeId(e.target.value)}
              className="bg-[var(--bark-900)] border border-[var(--bark-700)] rounded-lg px-2 py-1 text-[12px] text-slate-300 focus:border-[var(--leaf)] focus:outline-none"
            >
              {trees.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <button
              onClick={submit}
              disabled={!prompt.trim() || !treeId || starting}
              className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] text-white disabled:opacity-40"
            >
              {starting ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />} Start
            </button>
          </div>
        </div>
        {trees.length === 0 && (
          <p className="text-[12px] text-amber-400/80 mt-2">Make a tree first — work is filed under one.</p>
        )}
      </section>

      {/* ── Owed ── */}
      {attention.length > 0 && (
        <section>
          <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-2 flex items-center gap-1.5">
            <AlertTriangle size={11} className="text-amber-400" /> Needs you · {attention.length}
          </h3>
          <div className="space-y-1.5">
            {attention.slice(0, 6).map(({ leaf, reason }) => {
              const attempts = Array.isArray(leaf.attempts) ? leaf.attempts.length : 0;
              return (
                <button
                  key={leaf.id}
                  onClick={() => onOpenLeaf(leaf)}
                  className={`w-full text-left flex items-center gap-3 px-3 py-2.5 rounded-xl border transition-colors ${
                    reason === 'failed'
                      ? 'border-red-500/30 bg-red-950/10 hover:border-red-500/50'
                      : 'border-[var(--bark-600)] bg-[var(--bark-800)] hover:border-[var(--bark-500)]'
                  }`}
                >
                  {reason === 'failed'
                    ? <AlertTriangle size={14} className="text-red-400 shrink-0" />
                    : <Check size={14} className="text-emerald-400 shrink-0" />}
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] text-slate-200 truncate">{leaf.title}</div>
                    <div className="text-[11px] text-slate-500 truncate">
                      {reason === 'failed'
                        ? `failed${attempts > 1 ? ` ${attempts} times` : ''} · ${branchOf(leaf.branchId)}`
                        : `waiting for you to accept · ${branchOf(leaf.branchId)}`}
                    </div>
                  </div>
                  <span className="text-[11px] text-slate-500 shrink-0">
                    {reason === 'failed' ? 'review' : 'decide'}
                  </span>
                  <ArrowRight size={13} className="text-slate-600 shrink-0" />
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* ── Now ── */}
      <section>
        <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-2">Running</h3>
        {live.length === 0 ? (
          // Said plainly. An empty area here reads as a page that failed to load.
          <p className="text-[12px] text-slate-600">Nothing is running.</p>
        ) : (
          <div className="space-y-1.5">
            {live.map((leaf) => (
              <button
                key={leaf.id}
                onClick={() => onOpenLeaf(leaf)}
                className="w-full text-left flex items-center gap-3 px-3 py-2.5 rounded-xl border border-[var(--bark-600)] bg-[var(--bark-800)] hover:border-[var(--bark-500)]"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] text-slate-200 truncate">{leaf.title}</div>
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

      {/* ── While you were away ── */}
      {recent.length > 0 && (
        <section>
          <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-2 flex items-center gap-1.5">
            <Clock size={11} /> Since you last looked
          </h3>
          <div className="space-y-0.5">
            {recent.map((leaf) => {
              const state = stateFor(leaf, leaves);
              return (
                <button
                  key={leaf.id}
                  onClick={() => onOpenLeaf(leaf)}
                  className="w-full text-left flex items-center gap-2.5 px-3 py-1.5 rounded-lg hover:bg-[var(--bark-800)] text-[12px]"
                >
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${state ? STATE_DOT[state] : 'bg-slate-700'}`} />
                  <span className="text-slate-300 truncate flex-1">{leaf.title}</span>
                  <span className="text-slate-600 shrink-0">{state ? STATE_LABEL[state] : 'Cancelled'}</span>
                  <span className="text-slate-700 shrink-0 w-16 text-right">{ago(leaf.updatedAt)}</span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* ── Trees ── */}
      <section>
        <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-2 flex items-center gap-1.5">
          <TreesIcon size={11} className="text-[var(--leaf)]" /> Trees
        </h3>
        <div className="space-y-1.5">
          {rollups.map((r) => (
            <button
              key={r.id}
              onClick={() => onOpenTree(r.id)}
              className="w-full text-left px-3 py-2.5 rounded-xl border border-[var(--bark-600)] bg-[var(--bark-800)] hover:border-[var(--bark-500)]"
            >
              <div className="flex items-center gap-3">
                <span className="text-[13px] text-slate-200 font-medium truncate flex-1">{r.name}</span>
                <span className="text-[11px] text-slate-500 shrink-0">
                  {r.total === 0 ? 'nothing yet' : `${r.verified} verified`}
                  {r.claimed > 0 && <span className="text-amber-400/80"> · {r.claimed} claimed</span>}
                  {r.failed > 0 && <span className="text-red-400/80"> · {r.failed} failed</span>}
                </span>
              </div>
              {r.total > 0 && (
                /* Two bars, never one — the same refusal to add a claim to a verification that the
                   board makes, and it matters more here because a summary is scanned. */
                <div className="flex h-1.5 rounded-full overflow-hidden bg-[var(--bark-700)] mt-2">
                  <div className="bg-[var(--leaf)]" style={{ width: `${(r.verified / r.total) * 100}%` }} />
                  <div className="bg-amber-500/70" style={{ width: `${(r.claimed / r.total) * 100}%` }} />
                </div>
              )}
            </button>
          ))}
          {rollups.length === 0 && <p className="text-[12px] text-slate-600">No trees yet.</p>}
        </div>
      </section>
    </div>
  );
}
