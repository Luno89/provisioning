import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Check, CircleSlash, Trash2, Link2, Unlink, AlertTriangle, Coins, ShieldCheck,
  ShieldQuestion, GitBranch, GitMerge, FileCheck, BookOpen, RotateCw, Stethoscope, Loader2,
} from 'lucide-react';
import Markdown from './Markdown.js';
import LeafSteps from './LeafSteps.js';
import { STATE_LABEL, STATE_STYLE, STATE_HINT, stateFor, blockedBy, type Leaf } from './leaf-types.js';
import {
  acceptLeaf, cancelLeaf, retryLeaf, reviewLeaf, deleteLeaf, patchLeaf,
} from '../api/grove';
import { errorMessage } from '../api/client';

export default function LeafDetail({ leaf, subLeaves, all = [], onReview }: {
  leaf: Leaf;
  subLeaves: Leaf[];
  all?: Leaf[];
  onReview?: (branchId: string, prompt: string) => void;
}) {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['leaves'] });
    qc.invalidateQueries({ queryKey: ['tree-board'] });
  };
  const call = (fn: () => Promise<unknown>) => ({ mutationFn: fn, onSuccess: invalidate });

  const accept = useMutation(call(() => acceptLeaf(leaf.id)));
  const cancel = useMutation(call(() => cancelLeaf(leaf.id)));
  const remove = useMutation(call(() => deleteLeaf(leaf.id)));

  const raiseBudget = useMutation(call(() => patchLeaf(
    leaf.id,
    { maxTokens: (leaf.budget?.maxTokens ?? 0) * 2 },
  )));

  const retry = useMutation(call(() => retryLeaf(leaf.id)));
  const review = useMutation({
    mutationFn: () => reviewLeaf(leaf.id),
    onSuccess: (data) => onReview?.(data.branchId, data.prompt),
  });

  const derived = subLeaves.length > 0;
  const state = stateFor(leaf, all);
  const waiting = blockedBy(leaf, all);
  const pending = Math.max(waiting.length, leaf.status === 'succeeded' ? 0 : (leaf.dependsOn?.length ?? 0));
  const attempts = Array.isArray(leaf.attempts) ? leaf.attempts : [];
  const attemptCount = Array.isArray(leaf.attempts) ? leaf.attempts.length : Number(leaf.attempts ?? 0);
  const cap = leaf.budget?.maxTokens;
  const usedTotal = leaf.usageTotal?.tokens;
  const budgetLine = cap && typeof usedTotal === 'number'
    ? {
      used: usedTotal,
      cap,
      pct: Math.min(100, Math.round((usedTotal / cap) * 100)),
      tight: usedTotal / cap >= 0.8,
    }
    : undefined;

  return (
    <div className="max-w-3xl pb-10">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <h2 className="text-2xl font-bold text-slate-100 break-words">{leaf.title}</h2>
          <div className="flex items-center gap-3 mt-2 flex-wrap">
            <span
              className={`text-[11px] uppercase tracking-widest font-semibold ${state ? STATE_STYLE[state] : 'text-slate-600 line-through'}`}
              title={state ? `${STATE_HINT[state]} (api: ${leaf.status})` : `cancelled (api: ${leaf.status})`}
            >
              {state ? STATE_LABEL[state] : 'Cancelled'}
            </span>
            {derived && <span className="text-[11px] text-slate-600">derived from {subLeaves.length} sub-leaves</span>}
            {leaf.parentLeafId && (
              <span className="text-[11px] text-slate-600 flex items-center gap-1"
                title={leaf.blocking ? 'The parent waits for this' : 'This outlives its parent'}>
                {leaf.blocking ? <Link2 size={11} /> : <Unlink size={11} />}
                {leaf.blocking ? 'blocking' : 'detached'}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {leaf.status === 'proposed' && (
            <button onClick={() => accept.mutate()}
              className="px-3 py-1.5 rounded-lg bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] text-emerald-50 text-xs flex items-center gap-1.5">
              <Check size={13} /> Accept
            </button>
          )}
          {leaf.status === 'running' && (
            <button onClick={() => cancel.mutate()} title="Cancel"
              className="p-1.5 rounded-lg text-slate-500 hover:text-amber-400 hover:bg-[var(--bark-700)]"><CircleSlash size={15} /></button>
          )}
          <button onClick={() => remove.mutate()} title="Delete, with its sub-leaves"
            className="p-1.5 rounded-lg text-slate-500 hover:text-red-400 hover:bg-[var(--bark-700)]"><Trash2 size={15} /></button>
        </div>
      </div>

      {leaf.status === 'succeeded' && (
        <div className="mt-5 flex items-center gap-4 flex-wrap text-[12px]">
          {leaf.verified ? (
            <span className="flex items-center gap-1.5 text-green-400" title="Its tests ran and passed, or a promised file was checked">
              <ShieldCheck size={13} /> a check ran and passed
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-amber-400" title="Nothing checked this — the agent reported it succeeded">
              <ShieldQuestion size={13} /> nothing checked this
            </span>
          )}
          {leaf.findings && !leaf.outputBranch ? (
            <span className="flex items-center gap-1.5 text-slate-500" title="Research — the answer is stored on this leaf, not in a repository">
              <BookOpen size={13} /> answer, not code
            </span>
          ) : leaf.merged ? (
            <span className="flex items-center gap-1.5 text-slate-400" title="Merged into the project's default branch">
              <GitMerge size={13} /> on main
            </span>
          ) : leaf.outputBranch ? (
            <span className="flex items-center gap-1.5 text-slate-500" title="Pushed, but not merged — it may need a look">
              <GitBranch size={13} /> {leaf.outputBranch}
            </span>
          ) : null}
        </div>
      )}

      {leaf.status === 'failed' && (
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <button
            onClick={() => review.mutate()}
            disabled={review.isPending}
            title="Open Koala with this failure and ask it why. You can reply and argue with the answer."
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-[12px] bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] text-white disabled:opacity-50"
          >
            {review.isPending ? <Loader2 size={13} className="animate-spin" /> : <Stethoscope size={13} />}
            {review.isPending ? 'Opening Koala…' : 'Review the failure'}
          </button>
          <button
            onClick={() => retry.mutate()}
            disabled={retry.isPending}
            title="Run it again. The next attempt is given this failure, but a cause in the environment will repeat."
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-[12px] bg-[var(--bark-700)] hover:bg-[var(--bark-600)] text-slate-200 disabled:opacity-50"
          >
            {retry.isPending ? <Loader2 size={13} className="animate-spin" /> : <RotateCw size={13} />} Retry
          </button>
          {(review.error || retry.error) && (
            <span className="text-[11px] text-red-400">
              {errorMessage(review.error ?? retry.error) || 'That did not work.'}
            </span>
          )}
          {attemptCount > 1 && (
            <span className="text-[11px] text-slate-500">
              Already tried {attemptCount} times — a review is more likely to help than another run.
            </span>
          )}
        </div>
      )}

      {(pending > 0 || leaf.expects?.length) && (
        <div className="mt-4 flex flex-col gap-1.5 text-[12px] text-slate-500">
          {pending > 0 && (
            <span title="This does not start until they have succeeded">
              {waiting.length > 0
                ? `waits on ${waiting.map((w) => w.title).join(', ')}`
                : `waits on ${pending} other ${pending === 1 ? 'leaf' : 'leaves'}`}
            </span>
          )}
          {leaf.expects?.length ? (
            <span className="flex items-center gap-1.5" title="Checked after it runs: committed, non-empty, and changed">
              <FileCheck size={12} /> must produce {leaf.expects.join(', ')}
            </span>
          ) : null}
        </div>
      )}

      {leaf.findings && (
        <div className="mt-5">
          <h3 className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Findings</h3>
          <div className="text-[13px] text-slate-300 leading-relaxed rounded-xl border border-[var(--bark-600)] bg-[var(--bark-900)]/50 p-4 max-h-[32rem] overflow-y-auto">
            <Markdown>{leaf.findings}</Markdown>
          </div>
        </div>
      )}

      {leaf.summary && (
        <div className="mt-5">
          <h3 className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">What it reported</h3>
          <div className="text-[12px] text-slate-400 leading-relaxed border-l-2 border-[var(--bark-600)] pl-3">
            <Markdown>{leaf.summary}</Markdown>
          </div>
        </div>
      )}

      {leaf.body && (
        <div className="mt-5">
          <h3 className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">What it was asked to do</h3>
          <p className="text-sm text-slate-300 whitespace-pre-wrap leading-relaxed border-l-2 border-[var(--bark-600)] pl-4">
            {leaf.body}
          </p>
        </div>
      )}

      {attempts.length > 0 && (
        <div className="mt-6">
          <h3 className="text-[10px] font-black text-red-400/80 uppercase tracking-widest mb-2 flex items-center gap-1.5">
            <AlertTriangle size={11} /> {attempts.length} failed attempt{attempts.length > 1 ? 's' : ''}
          </h3>
          <ol className="space-y-2">
            {attempts.map((a) => (
              <li key={a.attempt} className="text-[12px] bg-red-950/20 border border-red-900/40 rounded-lg px-3 py-2">
                <span className="text-red-400/70 mr-2">#{a.attempt + 1}</span>
                <span className="text-slate-300">{a.error}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {(leaf.usage?.tokens || leaf.usageTotal?.tokens || leaf.budget) && (
        <div className="mt-6 flex flex-wrap gap-x-6 gap-y-1 text-[12px] text-slate-500">
          {leaf.usage?.tokens ? (
            <span className="flex items-center gap-1.5"><Coins size={12} /> {leaf.usage.tokens.toLocaleString()} tokens</span>
          ) : null}

          {budgetLine && (
            <span
              className={budgetLine.tight ? 'text-amber-400' : undefined}
              title={`${budgetLine.used.toLocaleString()} of ${budgetLine.cap.toLocaleString()} tokens used across this request`}
            >
              {budgetLine.pct}% of request budget used
              {budgetLine.tight ? ' — running low' : ''}
            </span>
          )}
          {budgetLine?.tight && (
            <button
              onClick={() => raiseBudget.mutate()}
              disabled={raiseBudget.isPending}
              className="text-[12px] text-[var(--leaf)] hover:underline disabled:opacity-50"
            >
              {raiseBudget.isPending ? 'raising…' : `raise to ${(budgetLine.cap * 2).toLocaleString()}`}
            </button>
          )}
        </div>
      )}

      <div className="mt-8 border-t border-[var(--bark-700)] pt-5">
        <h3 className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3">What it actually did</h3>
        <LeafSteps leafId={leaf.id} live={leaf.status === 'running'} />
      </div>
    </div>
  );
}
