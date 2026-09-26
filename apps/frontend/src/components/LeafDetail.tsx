import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CircleSlash, Trash2, AlertTriangle, ShieldCheck, RotateCw, Loader2 } from 'lucide-react';
import Markdown from './Markdown.js';
import ClaimReview from './ClaimReview.js';
import ConfirmDelete from './ConfirmDelete.js';
import { STATE_LABEL, STATE_STYLE, STATE_HINT, stateFor, blockedBy, type Leaf } from './leaf-types.js';
import { cancelLeaf, retryLeaf, deleteLeaf } from '../api/grove';
import { errorMessage } from '../api/client';

const ERROR_PREVIEW_CHARS = 240;

/**
 * A leaf failure's `error` can be a one-word code ("context_length_exceeded") or, when the
 * overthinking monitor fires, several KB of embedded loop transcript and shell commands — collapsed
 * to the first line by default so one attempt's error can't push the whole leaf view off screen.
 */
function AttemptError({ error }: { error: string }) {
  const [expanded, setExpanded] = useState(false);
  const firstLine = (error.split('\n')[0] ?? error).trim();
  const isLong = error.length > ERROR_PREVIEW_CHARS || error.includes('\n');
  const preview = firstLine.length > ERROR_PREVIEW_CHARS
    ? `${firstLine.slice(0, ERROR_PREVIEW_CHARS)}…`
    : firstLine;

  if (!isLong) {
    return <p className="text-slate-300 font-mono leading-relaxed break-words">{error}</p>;
  }

  return (
    <div>
      {expanded ? (
        <pre className="text-slate-300 font-mono leading-relaxed whitespace-pre-wrap break-words max-h-64 overflow-y-auto bg-red-950/20 rounded p-2 -mx-1">
          {error}
        </pre>
      ) : (
        <p className="text-slate-300 font-mono leading-relaxed break-words">{preview}</p>
      )}
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="text-[11px] text-red-400/70 hover:text-red-300 mt-1"
      >
        {expanded ? 'Show less' : `Show full error (${error.length.toLocaleString()} chars)`}
      </button>
    </div>
  );
}

export default function LeafDetail({ leaf, all = [] }: { leaf: Leaf; all?: Leaf[] }) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['leaves'] });
  const call = (fn: () => Promise<unknown>) => ({ mutationFn: fn, onSuccess: invalidate });

  const cancel = useMutation(call(() => cancelLeaf(leaf.id)));
  const remove = useMutation(call(() => deleteLeaf(leaf.id)));
  const retry = useMutation(call(() => retryLeaf(leaf.id)));
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const state = stateFor(leaf, all);
  const waiting = blockedBy(leaf, all);
  const attempts = leaf.attempts ?? [];

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
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {['pending', 'running', 'claimed'].includes(leaf.status) && (
            <button onClick={() => cancel.mutate()} disabled={cancel.isPending} title="Cancel — stop working this leaf; the rest of the tree carries on"
              className="p-1.5 rounded-lg text-slate-500 hover:text-amber-400 hover:bg-[var(--bark-700)] disabled:opacity-50"><CircleSlash size={15} /></button>
          )}
          <button onClick={() => setConfirmingDelete(true)} title="Delete this leaf"
            className="p-1.5 rounded-lg text-slate-500 hover:text-red-400 hover:bg-[var(--bark-700)]"><Trash2 size={15} /></button>
        </div>
      </div>

      {confirmingDelete && (
        <div className="mt-3">
          <ConfirmDelete
            prompt="Delete this leaf with its tasks and plans? A run in progress is stopped."
            confirmLabel="Delete leaf"
            pending={remove.isPending}
            onConfirm={() => remove.mutate()}
            onCancel={() => setConfirmingDelete(false)}
          />
        </div>
      )}

      {leaf.status === 'claimed' && <ClaimReview leaf={leaf} />}

      {leaf.status === 'succeeded' && (
        <div className="mt-5 flex items-center gap-4 flex-wrap text-[12px]">
          {leaf.verified && leaf.review?.model === 'person' ? (
            <span className="flex items-center gap-1.5 text-green-400" title="A judge could not settle the claim; a person read the evidence and verified it">
              <ShieldCheck size={13} /> a person verified it{leaf.review.reason ? ` — ${leaf.review.reason}` : ''}
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-green-400" title="The judge weighed the claim's evidence against the leaf's goal and verified it">
              <ShieldCheck size={13} /> the judge verified it{leaf.review?.reason ? ` — ${leaf.review.reason}` : ''}
            </span>
          )}
          {leaf.claim?.commit && (
            <span className="font-mono text-slate-500" title="The commit the judge checked out">{leaf.claim.commit.slice(0, 10)}</span>
          )}
        </div>
      )}

      {leaf.status === 'failed' && (
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <button
            onClick={() => retry.mutate()}
            disabled={retry.isPending}
            title="Run it again. The next attempt is given this failure, but a cause in the environment will repeat."
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-[12px] bg-[var(--bark-700)] hover:bg-[var(--bark-600)] text-slate-200 disabled:opacity-50"
          >
            {retry.isPending ? <Loader2 size={13} className="animate-spin" /> : <RotateCw size={13} />} Retry
          </button>
          {retry.error && (
            <span className="text-[11px] text-red-400">
              {errorMessage(retry.error) || 'That did not work.'}
            </span>
          )}
          {attempts.length > 0 && (
            <span className="text-[11px] text-slate-500">
              Already retried {attempts.length} {attempts.length === 1 ? 'time' : 'times'}.
            </span>
          )}
        </div>
      )}

      {waiting.length > 0 && (
        <p className="mt-4 text-[12px] text-slate-500" title="This does not start until they have succeeded">
          waits on {waiting.map((w) => w.title).join(', ')}
        </p>
      )}

      {leaf.findings && (
        <div className="mt-5">
          <h3 className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Findings</h3>
          <div className="text-[13px] text-slate-300 leading-relaxed rounded-xl border border-[var(--bark-600)] bg-[var(--bark-900)]/50 p-4 max-h-[32rem] overflow-y-auto">
            <Markdown>{leaf.findings}</Markdown>
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
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="text-red-400/70 font-semibold">Attempt #{a.attempt}</span>
                  {a.failedAt && (
                    <span className="text-slate-500 text-[11px]">{new Date(a.failedAt).toLocaleString()}</span>
                  )}
                </div>
                <AttemptError error={a.error} />
              </li>
            ))}
          </ol>
        </div>
      )}

    </div>
  );
}
