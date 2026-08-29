import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, ChevronRight, ChevronDown, Terminal, FileText, Brain } from 'lucide-react';
import { getLeafTrace } from '../api/grove';

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
  checkpoints?: { step: number; tokensUsed: number; sha?: string; branch?: string }[];
}

function callLabel(call: { name: string; arguments: string }): string {
  try {
    const args = JSON.parse(call.arguments);
    if (typeof args.command === 'string') return args.command;
    if (typeof args.path === 'string') return `${call.name} ${args.path}`;
    if (typeof args.query === 'string') return `${call.name} "${args.query}"`;
    if (typeof args.summary === 'string') return args.summary;
  } catch {
  }
  return call.arguments.slice(0, 120);
}

export default function LeafSteps({ leafId, live }: {
  leafId: string;
  live?: boolean;
}) {
  const [open, setOpen] = useState<number | null>(null);

  const { data, isLoading } = useQuery<Trace>({
    queryKey: ['leaf-trace', leafId],
    queryFn: () => getLeafTrace(leafId),
    ...(live ? { refetchInterval: 2000 } : {}),
  });

  if (isLoading) {
    return <div className="text-slate-500 flex items-center gap-2 text-[12px]"><Loader2 className="animate-spin" size={14} /> Loading the trace…</div>;
  }

  const usable = data && !data.missing && Array.isArray(data.steps);

  if (!usable) {
    return (
      <p className="text-slate-500 text-[12px]">
        {live
          ? 'Starting the sandbox — the first turn will appear here shortly.'
          : 'This leaf has not run yet, so there is nothing to replay.'}
      </p>
    );
  }

  const totalSteps = data.totalSteps ?? data.steps.length;
  const tokensUsed = data.tokensUsed ?? 0;

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-slate-500 pb-1 flex items-center gap-2">
        {live && (
          <span className="flex items-center gap-1.5 text-[var(--leaf)]">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--leaf)] animate-pulse" /> running
          </span>
        )}
        {totalSteps} {totalSteps === 1 ? 'turn' : 'turns'} · {tokensUsed.toLocaleString()} tokens
        {data.trimmed && data.dropped ? ` · ${data.dropped} middle turns dropped to fit` : ''}
        {data.checkpoints?.length
          ? ` · saved ${data.checkpoints.length}× (turns shown are since the last save)`
          : ''}
      </p>

      {data.steps.map((step, i) => {
        const previous = data.steps[i - 1];
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
