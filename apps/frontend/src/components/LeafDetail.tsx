import { useMutation, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { Check, CircleSlash, Trash2, Link2, Unlink, AlertTriangle, Coins, Clock } from 'lucide-react';
import { STATUS_LABEL, STATUS_STYLE, COLUMNS, type Leaf, type ColumnId } from './leaf-types.js';

/**
 * Everything about one leaf, shown beside the tree.
 *
 * The tree answers "what is the shape of this work"; this answers "what is going on with this
 * piece". Failure history lives here rather than in the tree because it is the thing you need when
 * something has gone wrong and pure noise when it has not.
 */
export default function LeafDetail({ apiBase, leaf, subLeaves }: { apiBase: string; leaf: Leaf; subLeaves: Leaf[] }) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['leaves'] });
  const call = (fn: () => Promise<unknown>) => ({ mutationFn: fn, onSuccess: invalidate });

  const accept = useMutation(call(() => axios.post(`${apiBase}/leaves/${leaf.id}/accept`, {}, { withCredentials: true })));
  const cancel = useMutation(call(() => axios.post(`${apiBase}/leaves/${leaf.id}/cancel`, {}, { withCredentials: true })));
  const remove = useMutation(call(() => axios.delete(`${apiBase}/leaves/${leaf.id}`, { withCredentials: true })));
  const move = useMutation({
    mutationFn: (column: ColumnId) => axios.patch(`${apiBase}/leaves/${leaf.id}`, { column }, { withCredentials: true }),
    onSuccess: invalidate,
  });

  // A leaf with children has a DERIVED status, so the server refuses a manual move. Offering the
  // control anyway would only produce an error.
  const derived = subLeaves.length > 0;

  return (
    <div className="max-w-3xl">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <h2 className="text-2xl font-bold text-slate-100 break-words">{leaf.title}</h2>
          <div className="flex items-center gap-3 mt-2 flex-wrap">
            <span className={`text-[11px] uppercase tracking-widest ${STATUS_STYLE[leaf.status]}`} title={leaf.status}>
              {STATUS_LABEL[leaf.status]}
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

      {leaf.body && (
        <p className="mt-5 text-sm text-slate-300 whitespace-pre-wrap leading-relaxed border-l-2 border-[var(--bark-600)] pl-4">
          {leaf.body}
        </p>
      )}

      {!derived && leaf.status !== 'proposed' && (
        <div className="mt-6">
          <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Column</label>
          <div className="flex gap-2">
            {COLUMNS.map((c) => (
              <button key={c.id} onClick={() => move.mutate(c.id)}
                className={`px-3 py-1.5 rounded-lg text-xs ${leaf.column === c.id ? 'bg-slate-700 text-slate-100' : 'bg-[var(--bark-800)] text-slate-500 hover:text-slate-300'}`}>
                {c.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Every failed attempt, not just the last — a leaf that failed three different ways is a
          different situation from one that failed the same way three times, and only the history
          tells them apart. This is also exactly what the next retry was given as context. */}
      {leaf.attempts && leaf.attempts.length > 0 && (
        <div className="mt-6">
          <h3 className="text-[10px] font-black text-red-400/80 uppercase tracking-widest mb-2 flex items-center gap-1.5">
            <AlertTriangle size={11} /> {leaf.attempts.length} failed attempt{leaf.attempts.length > 1 ? 's' : ''}
          </h3>
          <ol className="space-y-2">
            {leaf.attempts.map((a) => (
              <li key={a.attempt} className="text-[12px] bg-red-950/20 border border-red-900/40 rounded-lg px-3 py-2">
                <span className="text-red-400/70 mr-2">#{a.attempt + 1}</span>
                <span className="text-slate-300">{a.error}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {(leaf.usageTotal || leaf.budget) && (
        <div className="mt-6 flex gap-6 text-[12px] text-slate-500">
          {leaf.usageTotal && (
            <>
              <span className="flex items-center gap-1.5"><Coins size={12} /> {leaf.usageTotal.tokens.toLocaleString()} tokens</span>
              <span className="flex items-center gap-1.5"><Clock size={12} /> {Math.round(leaf.usageTotal.wallClockMs / 1000)}s</span>
            </>
          )}
          {leaf.budget?.maxTokens && <span>budget {leaf.budget.maxTokens.toLocaleString()}</span>}
        </div>
      )}
    </div>
  );
}
