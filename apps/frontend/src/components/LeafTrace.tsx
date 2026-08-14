import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { X, Loader2, ChevronRight, ChevronDown, Terminal, FileText, Brain, MessageSquare, RotateCw, Stethoscope } from 'lucide-react';

/**
 * What a leaf actually did, turn by turn.
 *
 * ── WHY THIS IS NEW RATHER THAN A TIDY-UP ──
 * None of this reached a screen before. A finished leaf showed a status dot and a one-line summary,
 * so the only way to answer "why did it do that" was to re-run the work by hand with a probe
 * script — which only works while the cause is still reproducible, and stops working the moment
 * anything is fixed. The loop was producing the record all along and the leaf path discarded it.
 *
 * ── SHOWN COLLAPSED ──
 * A run is up to forty turns and a single reasoning block has been measured at ~8,000 characters.
 * Dumping that is not transparency, it is a wall. Each turn is one line saying what it DID —
 * commands are the readable summary of a step — and opens to the reasoning, arguments and results
 * behind it.
 */

interface Step {
  step: number;
  reasoning?: string;
  content?: string;
  toolCalls: { name: string; arguments: string }[];
  toolResults: { name: string; result: string }[];
  tokens: number;
  truncated?: boolean;
}

interface Trace {
  steps: Step[];
  totalSteps: number;
  tokensUsed: number;
  trimmed?: boolean;
  dropped?: number;
  missing?: boolean;
}

/** A tool call rendered as the thing a person recognises: the command, or the path. */
function callLabel(call: { name: string; arguments: string }): string {
  try {
    const args = JSON.parse(call.arguments);
    if (typeof args.command === 'string') return args.command;
    if (typeof args.path === 'string') return `${call.name} ${args.path}`;
    if (typeof args.query === 'string') return `${call.name} "${args.query}"`;
    if (typeof args.summary === 'string') return args.summary;
  } catch {
    // A truncated or half-streamed argument is normal in a failed run — show what there is.
  }
  return call.arguments.slice(0, 120);
}

export default function LeafTrace({
  apiBase, leaf, personaName, onClose, onReview,
}: {
  apiBase: string;
  leaf: { id: string; title: string; branchId: string; tokens: number; attempts: number; column?: string; outputBranch?: string };
  personaName?: string | undefined;
  onClose: () => void;
  /** Hands the failure to Koala. This panel never talks to a model itself. */
  onReview?: (branchId: string, prompt: string) => void;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const qc = useQueryClient();

  /**
   * Two different things to do with a failure, offered together on purpose.
   *
   * Retrying is not a no-op — the loop feeds the last failure into the next prompt, so attempt two
   * is not attempt one. But it cannot fix an environmental cause, and every real cause found in
   * this system so far has been environmental. Offering only retry would make the useless action
   * the obvious one.
   */
  const retry = useMutation({
    mutationFn: () => axios.post(`${apiBase}/leaves/${leaf.id}/retry`, {}, { withCredentials: true }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['tree-board'] }); onClose(); },
  });
  /**
   * Fetches the evidence and hands it to the conversation.
   *
   * The route builds the prompt and stops — no model call here. Koala answers it as an ordinary
   * turn, which is what puts the EVIDENCE in the transcript rather than only the conclusion: the
   * first follow-up ("why do you think that?") then reaches a Koala that has actually seen the
   * trace.
   */
  const review = useMutation({
    mutationFn: () => axios
      .post(`${apiBase}/leaves/${leaf.id}/review`, {}, { withCredentials: true })
      .then((r) => r.data as { branchId: string; prompt: string }),
    onSuccess: (data) => { onClose(); onReview?.(data.branchId, data.prompt); },
  });

  const { data, isLoading } = useQuery<Trace>({
    queryKey: ['leaf-trace', leaf.id],
    queryFn: () => axios.get(`${apiBase}/leaves/${leaf.id}/trace`, { withCredentials: true }).then((r) => r.data),
  });

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-6 z-50" onClick={onClose}>
      <div
        className="bg-[var(--bark-900)] border border-[var(--bark-600)] rounded-2xl w-full max-w-4xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b border-[var(--bark-700)] flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="font-bold text-lg leading-snug">{leaf.title}</h3>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1.5 text-[11px] text-slate-500">
              {personaName && <span className="text-slate-400">{personaName}</span>}
              {leaf.column === 'claimed' && (
                <span className="text-amber-400/80">claimed — nothing checked this</span>
              )}
              {leaf.outputBranch && <span>on {leaf.outputBranch}</span>}
              {leaf.attempts > 1 && <span className="text-amber-400/80">{leaf.attempts} attempts</span>}
              <span className="flex items-center gap-1"><MessageSquare size={11} /> {leaf.branchId.slice(0, 8)}</span>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-slate-500 hover:text-slate-300 hover:bg-[var(--bark-700)]">
            <X size={17} />
          </button>
        </div>

        {leaf.column === 'failed' && (
          <div className="px-5 py-3 border-b border-[var(--bark-700)] flex flex-wrap items-center gap-2">
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
            {leaf.attempts > 1 && (
              // Said out loud, because at this point retrying is usually the wrong instinct.
              <span className="text-[11px] text-slate-500">
                Already tried {leaf.attempts} times — a review is more likely to help than another run.
              </span>
            )}
          </div>
        )}

        <div className="overflow-y-auto p-5 space-y-2">
          {isLoading && <div className="text-slate-500 flex items-center gap-2"><Loader2 className="animate-spin" size={16} /> Loading…</div>}

          {data?.missing && (
            /* A leaf that has not run is not a leaf whose record was lost — different things,
               and saying "no trace" for both would look like data loss. */
            <p className="text-slate-500 text-sm">
              This leaf has not run yet, so there is nothing to replay.
            </p>
          )}

          {data && !data.missing && (
            <>
              <p className="text-[11px] text-slate-500 pb-1">
                {data.totalSteps} {data.totalSteps === 1 ? 'turn' : 'turns'} · {data.tokensUsed.toLocaleString()} tokens
                {data.trimmed && data.dropped ? ` · ${data.dropped} middle turns dropped to fit` : ''}
              </p>

              {data.steps.map((step, i) => {
                const previous = data.steps[i - 1];
                // The gap is drawn, not implied: consecutive numbers that jump would otherwise read
                // as a short run rather than a trimmed one.
                const gap = previous && step.step > previous.step + 1;
                const isOpen = open === step.step;
                return (
                  <div key={step.step}>
                    {gap && (
                      <div className="text-[11px] text-slate-600 py-2 pl-2 border-l-2 border-dashed border-[var(--bark-600)] ml-2">
                        … {step.step - previous!.step - 1} turns not kept …
                      </div>
                    )}
                    <div className="bg-[var(--bark-800)] border border-[var(--bark-700)] rounded-xl">
                      <button
                        onClick={() => setOpen(isOpen ? null : step.step)}
                        className="w-full text-left px-3 py-2 flex items-center gap-2 min-w-0"
                      >
                        {isOpen ? <ChevronDown size={14} className="shrink-0 text-slate-500" /> : <ChevronRight size={14} className="shrink-0 text-slate-500" />}
                        <span className="text-[11px] text-slate-600 w-6 shrink-0">{step.step}</span>
                        {step.toolCalls.length > 0
                          ? <Terminal size={12} className="shrink-0 text-slate-500" />
                          : <Brain size={12} className="shrink-0 text-slate-600" />}
                        <span className="text-[12px] font-mono text-slate-300 truncate">
                          {step.toolCalls.length
                            ? step.toolCalls.map(callLabel).join('  |  ')
                            : (step.content?.trim().slice(0, 110) || 'no tool call — it answered in prose')}
                        </span>
                      </button>

                      {isOpen && (
                        <div className="px-3 pb-3 space-y-3 border-t border-[var(--bark-700)] pt-3">
                          {step.reasoning && (
                            <div>
                              <p className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1">Reasoning</p>
                              <pre className="text-[11px] text-slate-400 whitespace-pre-wrap font-sans leading-relaxed">{step.reasoning}</pre>
                            </div>
                          )}
                          {step.content && (
                            <div>
                              <p className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1">Said</p>
                              <pre className="text-[11px] text-slate-400 whitespace-pre-wrap font-sans leading-relaxed">{step.content}</pre>
                            </div>
                          )}
                          {step.toolCalls.map((call, n) => (
                            <div key={n}>
                              <p className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1 flex items-center gap-1.5">
                                <FileText size={11} /> {call.name}
                              </p>
                              <pre className="text-[11px] text-slate-300 whitespace-pre-wrap font-mono bg-[var(--bark-900)] rounded-lg p-2 overflow-x-auto">{call.arguments}</pre>
                            </div>
                          ))}
                          {step.toolResults.map((result, n) => (
                            <div key={n}>
                              <p className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1">Result</p>
                              <pre className="text-[11px] text-slate-400 whitespace-pre-wrap font-mono bg-[var(--bark-900)] rounded-lg p-2 overflow-x-auto max-h-64">{result.result}</pre>
                            </div>
                          ))}
                          {step.truncated && (
                            <p className="text-[10px] text-slate-600">Some fields were clipped when this turn was stored.</p>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
