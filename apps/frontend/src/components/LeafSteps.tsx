import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { Loader2, ChevronRight, ChevronDown, Terminal, FileText, Brain } from 'lucide-react';

/**
 * What a leaf actually did, turn by turn.
 *
 * ── WHY THIS IS ITS OWN FILE ──
 * It was the body of a modal that only the board could open, which meant the two leaf surfaces each
 * held half the story: the detail pane had the report, the task and the errors but could not show a
 * single thing the agent DID, and the trace modal showed every step but not what was asked or what
 * came back. Answering "why did this fail" needed both, reached by two unrelated routes.
 *
 * Extracted so one surface can hold everything. Nothing here decides layout or chrome — it renders
 * turns and nothing else.
 *
 * ── SHOWN COLLAPSED ──
 * A run is up to forty turns and a single reasoning block has been measured at ~8,000 characters.
 * Dumping that is not transparency, it is a wall. Each turn is one line saying what it DID —
 * commands are the readable summary of a step — and opens to the reasoning, arguments and results.
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

export default function LeafSteps({ apiBase, leafId, live }: {
  apiBase: string;
  leafId: string;
  /** Polls while the leaf is in a sandbox, so turns appear as they are taken. */
  live?: boolean;
}) {
  const [open, setOpen] = useState<number | null>(null);

  /**
   * Refetched while the leaf is running, so the turns appear as they happen.
   *
   * The worker writes each turn to the trace as it takes it — it runs in a different process from
   * the one holding the sockets, so the database is the channel both ends already share. Polling a
   * record that grows is the whole mechanism; there is no second transport to keep working.
   */
  const { data, isLoading } = useQuery<Trace>({
    queryKey: ['leaf-trace', leafId],
    queryFn: () => axios.get(`${apiBase}/leaves/${leafId}/trace`, { withCredentials: true }).then((r) => r.data),
    ...(live ? { refetchInterval: 2000 } : {}),
  });

  if (isLoading) {
    return <div className="text-slate-500 flex items-center gap-2 text-[12px]"><Loader2 className="animate-spin" size={14} /> Loading the trace…</div>;
  }

  if (data?.missing || !data) {
    return (
      /* A leaf that has not run is not a leaf whose record was lost — different things, and saying
         "no trace" for both would look like data loss. */
      <p className="text-slate-500 text-[12px]">
        {live
          // A running leaf with no turns yet is starting its sandbox, which takes seconds — saying
          // "has not run" there would read as broken.
          ? 'Starting the sandbox — the first turn will appear here shortly.'
          : 'This leaf has not run yet, so there is nothing to replay.'}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-slate-500 pb-1 flex items-center gap-2">
        {live && (
          <span className="flex items-center gap-1.5 text-[var(--leaf)]">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--leaf)] animate-pulse" /> running
          </span>
        )}
        {data.totalSteps} {data.totalSteps === 1 ? 'turn' : 'turns'} · {data.tokensUsed.toLocaleString()} tokens
        {data.trimmed && data.dropped ? ` · ${data.dropped} middle turns dropped to fit` : ''}
      </p>

      {data.steps.map((step, i) => {
        const previous = data.steps[i - 1];
        // The gap is drawn, not implied: consecutive numbers that jump would otherwise read as a
        // short run rather than a trimmed one.
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
    </div>
  );
}
