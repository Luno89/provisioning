import { useMutation, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import {
  Check, CircleSlash, Trash2, Link2, Unlink, AlertTriangle, Coins, Clock, ShieldCheck,
  ShieldQuestion, GitBranch, GitMerge, FileCheck, BookOpen, RotateCw, Stethoscope, Loader2,
} from 'lucide-react';
import Markdown from './Markdown.js';
import LeafSteps from './LeafSteps.js';
import { STATE_LABEL, STATE_STYLE, STATE_HINT, stateFor, blockedBy, type Leaf } from './leaf-types.js';

/**
 * Everything about one leaf — the only surface that describes one.
 *
 * ── WHY IT IS ONE SURFACE NOW ──
 * There used to be two, and neither was sufficient. This pane had the report, the task, the
 * dependencies and the failure history but could not show a single thing the agent DID. The board's
 * trace modal showed every turn but not what was asked, what came back, or what failed. Diagnosing
 * one leaf meant opening both, by two unrelated routes, and the modal meant two leaves could never
 * be compared.
 *
 * The order is the order you need it in when something has gone wrong: what state it is in, whether
 * anything checked it, what it claims it did, what it was asked to do, how it failed, and then —
 * last, because it is the longest and only sometimes the answer — every turn it took.
 */
export default function LeafDetail({ apiBase, leaf, subLeaves, all = [], onReview }: {
  apiBase: string;
  leaf: Leaf;
  subLeaves: Leaf[];
  /**
   * Every leaf, for deciding whether this one is blocked.
   *
   * State is derived rather than read off the record: the `column` field means different things
   * depending on which endpoint returned the leaf. See leaf-types.ts.
   */
  all?: Leaf[];
  /** Hands a failure to Koala. This pane never talks to a model itself. */
  onReview?: (branchId: string, prompt: string) => void;
}) {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['leaves'] });
    qc.invalidateQueries({ queryKey: ['tree-board'] });
  };
  const call = (fn: () => Promise<unknown>) => ({ mutationFn: fn, onSuccess: invalidate });

  const accept = useMutation(call(() => axios.post(`${apiBase}/leaves/${leaf.id}/accept`, {}, { withCredentials: true })));
  const cancel = useMutation(call(() => axios.post(`${apiBase}/leaves/${leaf.id}/cancel`, {}, { withCredentials: true })));
  const remove = useMutation(call(() => axios.delete(`${apiBase}/leaves/${leaf.id}`, { withCredentials: true })));

  /**
   * Two different things to do with a failure, offered together on purpose.
   *
   * Retrying is not a no-op — the loop feeds the last failure into the next prompt, so attempt two
   * is not attempt one. But it cannot fix an environmental cause, and every real cause found in this
   * system so far has been environmental. Offering only retry would make the useless action the
   * obvious one.
   */
  const retry = useMutation(call(() => axios.post(`${apiBase}/leaves/${leaf.id}/retry`, {}, { withCredentials: true })));
  /**
   * Fetches the evidence and hands it to the conversation.
   *
   * The route builds the prompt and stops — no model call here. Koala answers it as an ordinary
   * turn, which is what puts the EVIDENCE in the transcript rather than only the conclusion.
   */
  const review = useMutation({
    mutationFn: () => axios
      .post(`${apiBase}/leaves/${leaf.id}/review`, {}, { withCredentials: true })
      .then((r) => r.data as { branchId: string; prompt: string }),
    onSuccess: (data) => onReview?.(data.branchId, data.prompt),
  });

  // A leaf with children has a DERIVED status, so the server refuses a manual move.
  const derived = subLeaves.length > 0;
  const state = stateFor(leaf, all);
  const waiting = blockedBy(leaf, all);
  // What it declared it waits on, which is knowable without the other records; `waiting` is the
  // subset those records could actually be found for.
  const pending = Math.max(waiting.length, leaf.status === 'succeeded' ? 0 : (leaf.dependsOn?.length ?? 0));
  /**
   * The failure history, which is an ARRAY on a leaf record and a COUNT on a board payload.
   *
   * The same field name carrying two shapes is the second instance of this hazard in one type (see
   * `column` in leaf-types.ts). Guarded rather than trusted: reading `.length` off a number is
   * silent — it yields undefined, so the whole failure history simply disappears from the panel.
   */
  const attempts = Array.isArray(leaf.attempts) ? leaf.attempts : [];
  const attemptCount = Array.isArray(leaf.attempts) ? leaf.attempts.length : Number(leaf.attempts ?? 0);

  return (
    <div className="max-w-3xl pb-10">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <h2 className="text-2xl font-bold text-slate-100 break-words">{leaf.title}</h2>
          <div className="flex items-center gap-3 mt-2 flex-wrap">
            {/* One word for the state, the same word the board uses. The raw API status stays as a
                tooltip so a log line and the screen can still be matched up. */}
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

      {/*
        * ── WHAT CHECKED THIS, AND WHERE THE WORK WENT ──
        * A success meaning "its tests ran and passed" and one meaning "the agent said so" used to
        * look identical, and there was no path at all from a finished leaf to the branch it made.
        */}
      {leaf.status === 'succeeded' && (
        <div className="mt-5 flex items-center gap-4 flex-wrap text-[12px]">
          {/*
            * The state chip above already says Verified or Claimed, so this says WHY rather than
            * repeating it — the two used to be separate surfaces and each needed its own verdict.
            * Saying it twice is how a page starts reading as noise.
            */}
          {leaf.verified ? (
            <span className="flex items-center gap-1.5 text-green-400" title="Its tests ran and passed, or a promised file was checked">
              <ShieldCheck size={13} /> a check ran and passed
            </span>
          ) : (
            /* Deliberately not styled as a failure. An unverified success is still a success — most
               work is not test-shaped — it is just not evidence, and saying so is the whole point. */
            <span className="flex items-center gap-1.5 text-amber-400" title="Nothing checked this — the agent reported it succeeded">
              <ShieldQuestion size={13} /> nothing checked this
            </span>
          )}
          {/*
            * Work that produced an ANSWER has no branch and never will, so the merge state is not a
            * gap to report. Read from what the leaf produced rather than from a label.
            */}
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

      {/* ── The two things to do about a failure ── */}
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
              {String((review.error as any)?.response?.data?.error ?? (retry.error as any)?.response?.data?.error ?? 'That did not work.')}
            </span>
          )}
          {attemptCount > 1 && (
            // Said out loud, because at this point retrying is usually the wrong instinct.
            <span className="text-[11px] text-slate-500">
              Already tried {attemptCount} times — a review is more likely to help than another run.
            </span>
          )}
        </div>
      )}

      {/* The ordering you agreed to when you accepted, and the files it promised. */}
      {(pending > 0 || leaf.expects?.length) && (
        <div className="mt-4 flex flex-col gap-1.5 text-[12px] text-slate-500">
          {pending > 0 && (
            /**
             * Named when the records are to hand, counted when they are not.
             *
             * "waits on the transport leaf" is actionable where "waits on 1 leaf" is not — but this
             * pane is also opened without the full list, and resolving titles against a list it does
             * not have made a blocked leaf claim it was waiting for nothing at all.
             */
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

      {/*
        * A research leaf's actual answer, above its self-report.
        *
        * The deliverable, not a description of one — so it is presented as content rather than as a
        * claim, which is the opposite of how the summary below is framed.
        */}
      {leaf.findings && (
        <div className="mt-5">
          <h3 className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Findings</h3>
          <div className="text-[13px] text-slate-300 leading-relaxed rounded-xl border border-[var(--bark-600)] bg-[var(--bark-900)]/50 p-4 max-h-[32rem] overflow-y-auto">
            <Markdown>{leaf.findings}</Markdown>
          </div>
        </div>
      )}

      {/* The agent's own account of what it did. Labelled as a report rather than presented as
          fact, because that is exactly what it is. */}
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

      {/* Every failed attempt, not just the last — a leaf that failed three different ways is a
          different situation from one that failed the same way three times, and only the history
          tells them apart. This is also exactly what the next retry was given as context. */}
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

      {/*
        * Last, because it is the longest thing here and only sometimes the answer.
        *
        * Not a modal any more: it used to be, which meant the turns could only be read on top of a
        * dimmed board and never beside the task that produced them.
        */}
      <div className="mt-8 border-t border-[var(--bark-700)] pt-5">
        <h3 className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3">What it actually did</h3>
        {/* Rendered for every state, including proposed: "this has not run yet" is a different
            answer from a missing record, and hiding the section made them look the same. */}
        <LeafSteps apiBase={apiBase} leafId={leaf.id} live={leaf.status === 'running'} />
      </div>
    </div>
  );
}
