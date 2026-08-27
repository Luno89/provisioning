import { useState, Fragment } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, Loader2, Check, ArrowRight, Trees as TreesIcon, Clock, Sparkles,
  GitBranch, Coins, MessageSquare, RotateCcw, X, SearchCheck, Box, ExternalLink, ShieldCheck,
} from 'lucide-react';
import {
  needsYou, running, changedSince, treeRollups, scopeToTree, groupWork, ago,
  settledBranches, outstandingWork,
} from './home-summary.js';
import { STATE_DOT, STATE_LABEL, STATE_STYLE, stateFor, type Leaf } from './leaf-types.js';
import { KoalaSpot } from './Koala.js';
import { cancelLeaf, recheckLeaf } from '../api/grove';
import { errorMessage } from '../api/client';
import { listProjects } from '../api/projects';

export default function Home({
  leaves, branches, trees, tree, lastSeen, personaNames = {},
  onStart, onOpenLeaf, onOpenTree, onOpenBranch, starting,
}: {
  leaves: Leaf[];
  branches: { id: string; title: string; treeId?: string }[];
  trees: { id: string; name: string }[];
  /** The project in view. Absent means everything you own. */
  tree?: { id: string; name: string; goal?: string; projectIds?: string[] } | undefined;
  lastSeen?: string | undefined;
  /** Who did the work. An id tells nobody anything, so the rows carry the name. */
  personaNames?: Record<string, string>;
  onStart: (treeId: string, prompt: string) => void;
  onOpenLeaf: (leaf: Leaf) => void;
  onOpenTree: (treeId: string) => void;
  onOpenBranch?: (branchId: string) => void;
  starting?: boolean;
}) {
  const qc = useQueryClient();

  const drop = useMutation({
    mutationFn: (id: string) => cancelLeaf(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['leaves'] }),
  });

  const [recheck, setRecheck] = useState<Record<string, string>>({});
  const lookAgain = useMutation({
    mutationFn: (id: string) => recheckLeaf(id).then((out) => ({ id, ...out })),
    onSuccess: (out) => {
      setRecheck((r) => ({ ...r, [out.id]: out.reason }));
      if (out.changed) qc.invalidateQueries({ queryKey: ['leaves'] });
    },
    onError: (err: unknown, id) => setRecheck((r) => ({
      ...r, [id]: errorMessage(err) || 'Could not read the repository.',
    })),
  });

  const [prompt, setPrompt] = useState('');
  const [pickedTree, setPickedTree] = useState(() => localStorage.getItem('grove-tree') ?? trees[0]?.id ?? '');

  // Query projects for linked CI/CD telemetry
  const { data: allProjects = [] } = useQuery<any[]>({
    queryKey: ['projects'],
    queryFn: () => listProjects<any>(),
    staleTime: 10_000,
  });

  const linkedProject = tree
    ? allProjects.find((p) => p.name === tree.name || tree.projectIds?.includes(p.id))
    : undefined;

  // Scoped or not, every section below reads from the same pair.
  const scoped = tree ? scopeToTree(tree.id, branches, leaves) : { branches, leaves };
  const treeId = tree?.id ?? pickedTree;

  const settled = settledBranches(scoped.branches, scoped.leaves);
  const attention = tree
    ? needsYou(scoped.leaves, settled)
    : needsYou(scoped.leaves, settled).slice(0, 6);
  const owed = outstandingWork(scoped.branches, scoped.leaves);
  const live = running(scoped.leaves);
  const recent = changedSince(scoped.leaves, lastSeen).slice(0, 6);
  const rollups = treeRollups(trees, branches, leaves);

  const shownAbove = new Set([...attention.map((a) => a.leaf.id), ...owed.map((o) => o.leaf.id)]);
  const work = tree
    ? groupWork(scoped.leaves.filter((l) => !shownAbove.has(l.id))).filter((g) => g.leaves.length > 0)
    : [];
  const branchOf = (id: string) => branches.find((b) => b.id === id)?.title ?? '';

  const mine = tree ? rollups.find((r) => r.id === tree.id) : undefined;
  const spent = scoped.leaves.reduce((sum, l) => sum + (l.usage?.tokens ?? 0), 0);
  const retried = scoped.leaves.filter((l) => (Array.isArray(l.attempts) ? l.attempts.length : 0) > 1).length;

  const submit = () => {
    const text = prompt.trim();
    if (!text || !treeId) return;
    setPrompt('');
    onStart(treeId, text);
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
        {(Array.isArray(leaf.attempts) ? leaf.attempts.length : 0) > 1 && (
          <span className="text-amber-400/70 shrink-0">{(leaf.attempts as unknown[]).length} attempts</span>
        )}
        {leaf.personaId && <span className="text-slate-500 shrink-0">{personaNames[leaf.personaId] ?? 'persona'}</span>}
        {leaf.merged && <span className="text-[var(--leaf)]/70 shrink-0">merged</span>}
        {leaf.usage?.tokens ? <span className="text-slate-600 shrink-0">{Math.round(leaf.usage.tokens / 1000)}k</span> : null}
        <span className="text-slate-500 shrink-0 w-16 text-right">{ago(leaf.updatedAt)}</span>
      </button>
    );
  };

  return (
    <div className="max-w-4xl mx-auto py-6 space-y-6 overflow-y-auto h-full pr-2">
      {/* ── Say something ── */}
      <section>
        <div className="flex items-center gap-2.5 mb-1">
          <KoalaSpot size={28} mood="happy" />
          <h2 className="text-lg font-bold truncate text-slate-100">{tree ? tree.name : 'What should Koala build?'}</h2>
        </div>
        {tree?.goal && <p className="text-xs text-slate-400 mb-3 ml-9">{tree.goal}</p>}
        {!tree && <div className="mb-3" />}

        <div className="rounded-lg border border-[var(--bark-700)] bg-[var(--bark-900)]/60 p-3 shadow-xs">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); }}
            rows={3}
            placeholder={tree
              ? `Ask for more work on ${tree.name}, or ask about what is already there.`
              : 'Describe what you want made. Koala will break it into leaves and ask before it runs anything.'}
            className="w-full bg-transparent text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none resize-none leading-relaxed"
          />
          <div className="flex items-center gap-2 pt-2 border-t border-[var(--bark-800)]">
            {!tree && (
              <>
                <span className="text-[11px] text-slate-500">in</span>
                <select
                  value={pickedTree}
                  onChange={(e) => setPickedTree(e.target.value)}
                  className="bg-[var(--bark-950)] border border-[var(--bark-700)] rounded-md px-2 py-1 text-xs text-slate-300 focus:border-[var(--leaf)] focus:outline-none"
                >
                  {trees.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </>
            )}
            <button
              onClick={submit}
              disabled={!prompt.trim() || !treeId || starting}
              className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40 shadow-xs transition-colors"
            >
              {starting ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />} Start
            </button>
          </div>
        </div>
        {trees.length === 0 && (
          <p className="text-xs text-amber-400/80 mt-2">Make a tree first — work is filed under one.</p>
        )}
      </section>

      {/* ── Linked CI/CD & Deployment Pipeline Hub ── */}
      {tree && linkedProject && (
        <section className="rounded-lg border border-[var(--bark-800)] bg-[var(--bark-900)]/40 p-4 space-y-3 font-mono">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <Box size={16} className="text-blue-400 shrink-0" />
              <span className="text-xs font-bold text-slate-200">{linkedProject.giteaOwner}/{linkedProject.giteaRepo}</span>
              {linkedProject.autoDeployOnBuild && (
                <span className="text-[10px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 rounded flex items-center gap-1">
                  <ShieldCheck size={10} /> auto-deploy
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-slate-400">Status: <span className="text-slate-200 font-bold">{linkedProject.status || 'no-build'}</span></span>
              {linkedProject.status === 'running' && (
                <a
                  href={`http://${linkedProject.name.toLowerCase()}.apps.local`}
                  target="_blank"
                  rel="noreferrer"
                  className="bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 text-xs font-medium px-2 py-0.5 rounded flex items-center gap-1 transition-colors"
                >
                  <ExternalLink size={11} /> Open App
                </a>
              )}
            </div>
          </div>
          <div className="text-[11px] text-slate-400 flex items-center gap-4 flex-wrap pt-1 border-t border-[var(--bark-800)]/60">
            <span>Cluster: <span className="text-slate-300">{linkedProject.targetClusterId || 'default'}</span></span>
            {linkedProject.lastBuildStatus && <span>Build: <span className="text-slate-300">{linkedProject.lastBuildStatus}</span></span>}
          </div>
        </section>
      )}

      {/* ── Where the project stands ── */}
      {tree && mine && mine.total > 0 && (
        <section className="rounded-lg border border-[var(--bark-800)] bg-[var(--bark-900)]/40 p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-slate-400">
            <span className="flex items-center gap-1.5"><Coins size={13} /> {spent >= 1000 ? `${Math.round(spent / 1000)}k` : spent} tokens</span>
            <span className="flex items-center gap-1.5">
              <MessageSquare size={13} /> {scoped.branches.length} {scoped.branches.length === 1 ? 'conversation' : 'conversations'}
            </span>
            {retried > 0 && (
              <span className="flex items-center gap-1.5 text-amber-400/80" title="Leaves that needed more than one attempt">
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

      {/* ── Owed ── */}
      {attention.length > 0 && (
        <section>
          <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-2 flex items-center gap-1.5">
            <AlertTriangle size={11} className="text-amber-400" /> Needs you · {attention.length}
          </h3>
          <div className="space-y-1.5">
            {attention.map(({ leaf, reason }) => {
              const attempts = Array.isArray(leaf.attempts) ? leaf.attempts.length : 0;
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
                    : <Check size={14} className="text-emerald-400 shrink-0" />}
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-slate-200 truncate">{leaf.title}</div>
                    <div className="text-[11px] text-slate-500 truncate">
                      {reason === 'failed'
                        ? `failed${attempts > 1 ? ` ${attempts} times` : ''} · ${branchOf(leaf.branchId)}`
                        : `waiting for you to accept · ${branchOf(leaf.branchId)}`}
                    </div>
                  </div>
                  <span className="text-[11px] text-slate-500 shrink-0">{reason === 'failed' ? 'review' : 'decide'}</span>
                  <ArrowRight size={13} className="text-slate-600 shrink-0" />
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* ── Owed by finished runs ── */}
      {owed.length > 0 && (
        <section>
          <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-2">
            Attempted, not delivered · {owed.length}
          </h3>
          <p className="text-[11px] text-slate-500 mb-2">
            From runs that have finished. Ask Koala above to pick any of these up again.
          </p>
          <div className="space-y-1.5">
            {owed.map(({ leaf, from, evidence }) => (
              <button
                key={leaf.id}
                onClick={() => onOpenLeaf(leaf)}
                className="w-full text-left flex items-center gap-3 px-3 py-2 rounded-md border border-[var(--bark-700)] bg-[var(--bark-900)]/40 hover:border-[var(--bark-600)] transition-colors"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-rose-500/50 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-slate-300 truncate">{leaf.title}</div>
                  <div className="text-[11px] text-slate-500 truncate" title={evidence}>{evidence}</div>
                  <div className="text-[10px] text-slate-600 truncate">from “{from}”</div>
                  {recheck[leaf.id] && (
                    <div className="text-[11px] text-[var(--leaf)] mt-1 whitespace-normal">{recheck[leaf.id]}</div>
                  )}
                </div>
                {leaf.outputBranch && (
                  <span
                    role="button"
                    tabIndex={0}
                    title={`Look again — check whether the work is on ${leaf.outputBranch}`}
                    onClick={(e) => { e.stopPropagation(); lookAgain.mutate(leaf.id); }}
                    className="p-1.5 rounded-md text-slate-500 hover:text-[var(--leaf)] hover:bg-[var(--bark-800)] shrink-0 transition-colors"
                  >
                    <SearchCheck size={13} />
                  </span>
                )}
                <span
                  role="button"
                  tabIndex={0}
                  title="Drop this — it stops being owed, and will not be proposed again"
                  onClick={(e) => { e.stopPropagation(); drop.mutate(leaf.id); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); drop.mutate(leaf.id); } }}
                  className="p-1.5 rounded-md text-slate-500 hover:text-rose-400 hover:bg-[var(--bark-800)] shrink-0 transition-colors"
                >
                  <X size={13} />
                </span>
                <ArrowRight size={13} className="text-slate-600 shrink-0" />
              </button>
            ))}
          </div>
        </section>
      )}

      {/* ── Running Leaves ── */}
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

      {/* ── While you were away ── */}
      {recent.length > 0 && (
        <section>
          <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-2 flex items-center gap-1.5">
            <Clock size={11} /> Since you last looked
          </h3>
          <div className="space-y-0.5">{recent.map((l) => leafRow(l, `recent-${l.id}`))}</div>
        </section>
      )}

      {/* ── The project's conversations ── */}
      {tree && scoped.branches.length > 0 && onOpenBranch && (
        <section>
          <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-2 flex items-center gap-1.5">
            <MessageSquare size={11} /> Conversations
          </h3>
          <div className="space-y-0.5">
            {scoped.branches.map((b) => (
              <button
                key={b.id}
                onClick={() => onOpenBranch(b.id)}
                className="w-full text-left flex items-center gap-2.5 px-3 py-1.5 rounded-md hover:bg-[var(--bark-800)] text-xs text-slate-300 transition-colors"
              >
                <GitBranch size={12} className="text-slate-500 shrink-0" />
                <span className="truncate flex-1">{b.title}</span>
                <span className="text-slate-500 shrink-0 font-mono text-[11px]">
                  {scoped.leaves.filter((l) => l.branchId === b.id).length} leaves
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* ── All the work, grouped rather than columned ── */}
      {tree && work.length > 0 && (
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

      {/* ── Trees, only at the top level ── */}
      {!tree && (
        <section>
          <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-2 flex items-center gap-1.5">
            <TreesIcon size={11} className="text-[var(--leaf)]" /> Trees
          </h3>
          <div className="space-y-1.5">
            {rollups.map((r) => (
              <button
                key={r.id}
                onClick={() => onOpenTree(r.id)}
                className="w-full text-left px-3 py-2 rounded-md border border-[var(--bark-700)] bg-[var(--bark-900)]/40 hover:border-[var(--bark-600)] transition-colors"
              >
                <div className="flex items-center gap-3">
                  <span className="text-xs text-slate-200 font-medium truncate flex-1">{r.name}</span>
                  <span className="text-[11px] text-slate-500 shrink-0 font-mono">
                    {r.total === 0 ? 'nothing yet' : `${r.verified} verified`}
                    {r.claimed > 0 && <span className="text-amber-400/80"> · {r.claimed} claimed</span>}
                    {r.failed > 0 && <span className="text-rose-400/80"> · {r.failed} failed</span>}
                  </span>
                </div>
                {r.total > 0 && (
                  <div className="flex h-1.5 rounded-full overflow-hidden bg-[var(--bark-700)] mt-2">
                    <div className="bg-[var(--leaf)]" style={{ width: `${(r.verified / r.total) * 100}%` }} />
                    <div className="bg-amber-500/70" style={{ width: `${(r.claimed / r.total) * 100}%` }} />
                  </div>
                )}
              </button>
            ))}
            {rollups.length === 0 && <p className="text-xs text-slate-500">No trees yet.</p>}
          </div>
        </section>
      )}
    </div>
  );
}
