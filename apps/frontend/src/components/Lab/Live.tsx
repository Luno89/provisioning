import { useEffect, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import type { AgentStep } from './shared';

export interface LiveRun {
  taskId: string;
  taskName?: string;
  label: string;
  done?: number;
  total?: number;
  steps: AgentStep[];
}


export function LivePanel({ run }: { run: LiveRun }) {
  const tail = useRef<HTMLDivElement | null>(null);

  // Follows the stream, since the interesting step is the one that just happened.
  useEffect(() => { tail.current?.scrollIntoView({ block: 'nearest' }); }, [run.steps.length]);

  const last = run.steps[run.steps.length - 1];

  return (
    <div className="border-t border-[var(--bark-600)] bg-[var(--bark-900)]/40 px-4 py-3">
      <div className="flex items-center gap-2 mb-2">
        <Loader2 size={12} className="animate-spin text-[var(--leaf-light)]" />
        <span className="text-[11px] text-slate-400">
          {run.taskName ?? run.taskId} · <span className="font-mono">{run.label}</span>
          {run.done && run.total ? <span className="text-slate-600"> · run {run.done}/{run.total}</span> : null}
        </span>
        {last && (
          <span className="ml-auto text-[10px] text-slate-600 font-mono">
            step {last.step} · {last.tokens.toLocaleString()}t
          </span>
        )}
      </div>

      {run.steps.length === 0 ? (
        <p className="text-[11px] text-slate-600">Waiting for the first step…</p>
      ) : (
        <div className="space-y-1 max-h-56 overflow-y-auto">
          {run.steps.map((s) => (
            <div key={s.step} className="text-[11px] flex items-start gap-2 border-b border-[var(--bark-800)]/40 pb-1 pt-0.5">
              <span className="text-slate-600 font-mono shrink-0 pt-0.5">{String(s.step).padStart(2, ' ')}</span>
              <div className="min-w-0 flex-1 space-y-0.5">
                {s.content && (
                  <pre className="text-slate-300 whitespace-pre-wrap font-mono text-[10px] leading-relaxed bg-[var(--bark-900)]/60 rounded px-2 py-1 border-l-2 border-[var(--leaf-stem)]">
                    {s.content}
                  </pre>
                )}
                {s.toolCalls.length === 0 ? (
                  !s.content && (
                    <span className="text-amber-400">no tool call — {s.reasoning ? 'spent the turn reasoning' : 'answered in prose'}</span>
                  )
                ) : (
                  s.toolCalls.map((c, i) => (
                    <div key={i} className="min-w-0">
                      <span className="text-[var(--leaf-light)] font-mono font-semibold">{c.name}</span>
                      <span className="text-slate-400 font-mono ml-1.5 break-all">
                        {summariseArgs(c.arguments)}
                      </span>
                      {s.toolResults[i] && (
                        <span className="text-slate-500 ml-1.5">→ {summariseResult(s.toolResults[i]!.result)}</span>
                      )}
                    </div>
                  ))
                )}
                {s.reasoning && (
                  <div className="text-slate-500 text-[10px] italic">
                    thought ({s.reasoning.length}c): {s.reasoning.slice(0, 150)}{s.reasoning.length > 150 ? '…' : ''}
                  </div>
                )}
              </div>
            </div>
          ))}
          <div ref={tail} />
        </div>
      )}
    </div>
  );
}

/** The command or path out of a tool call's JSON, so a step reads as one line. */
function summariseArgs(args: string): string {
  try {
    const parsed = JSON.parse(args);
    const text = String(parsed.command ?? parsed.path ?? parsed.summary ?? '');
    return text.length > 90 ? `${text.slice(0, 90)}…` : text;
  } catch {
    // Arguments stream in fragments and the tail of a run can be mid-object.
    return args.slice(0, 90);
  }
}

/** Exit code if there is one, since that is what says whether the step worked. */
function summariseResult(result: string): string {
  try {
    const parsed = JSON.parse(result);
    if (parsed.exitCode !== undefined) {
      return parsed.exitCode === 0 ? 'ok' : `exit ${parsed.exitCode}`;
    }
    if (parsed.written) return `wrote ${parsed.bytes ?? '?'}b`;
    if (parsed.error) return String(parsed.error).slice(0, 60);
    return 'ok';
  } catch {
    return result.slice(0, 40);
  }
}
