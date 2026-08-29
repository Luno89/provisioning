import { useEffect, useRef, useState } from 'react';
import { Loader2, CheckCircle2, XCircle } from 'lucide-react';
import type { LiveRun } from './Live';
import type { AgentStep, ConversationMessage, VariantResult } from './shared';

function Step({ step }: { step: AgentStep }) {
  return (
    <div className="border-l-2 border-[var(--bark-600)] pl-2">
      <p className="text-[9px] uppercase tracking-widest text-slate-600">
        step {step.step} · {step.tokens.toLocaleString()}t{step.truncated ? ' · truncated' : ''}
      </p>
      {step.reasoning && (
        <pre className="text-[10px] text-slate-600 whitespace-pre-wrap leading-relaxed">{step.reasoning}</pre>
      )}
      {step.content && (
        <pre className="text-[10px] text-slate-300 whitespace-pre-wrap leading-relaxed">{step.content}</pre>
      )}
      {step.toolCalls.length === 0 ? (
        <p className="text-[10px] text-amber-400">no tool call</p>
      ) : step.toolCalls.map((c, i) => (
        <div key={i}>
          <p className="text-[10px] font-mono text-[var(--leaf-light)] break-all">
            {c.name} {c.arguments}
          </p>
          {step.toolResults[i] && (
            <pre className="text-[10px] text-slate-500 whitespace-pre-wrap break-all">
              → {step.toolResults[i]!.result}
            </pre>
          )}
        </div>
      ))}
    </div>
  );
}

function Conversation({ messages }: { messages: ConversationMessage[] }) {
  return (
    <div className="space-y-2">
      {messages.map((m, i) => (
        <div key={i}>
          <p className="text-[9px] uppercase tracking-widest text-slate-600">
            {m.role}{m.truncated ? ' · truncated at 6,000 chars' : ''}
          </p>
          <pre className="text-[10px] text-slate-400 whitespace-pre-wrap leading-relaxed">{m.content}</pre>
          {(m.toolCalls ?? []).map((c, j) => (
            <p key={j} className="text-[10px] font-mono text-[var(--leaf-light)] break-all">
              → {c.name} {c.arguments}
            </p>
          ))}
        </div>
      ))}
    </div>
  );
}

export function OutputPane({
  live, results, heading,
}: {
  live: LiveRun | undefined;
  results: VariantResult[];
  heading: string;
}) {
  const [pick, setPick] = useState<number | null>(null);
  const [view, setView] = useState<'sent' | 'produced'>('produced');
  const tail = useRef<HTMLDivElement | null>(null);

  useEffect(() => { tail.current?.scrollIntoView({ block: 'nearest' }); }, [live?.steps.length]);

  const index = pick !== null && pick < results.length ? pick : results.length - 1;
  const shown = results[index];

  if (live) {
    return (
      <div className="overflow-y-auto p-4">
        <div className="flex items-baseline gap-2 mb-2">
          <p className={heading}>Model output</p>
          <Loader2 size={11} className="animate-spin text-[var(--leaf-light)]" />
          <span className="text-[10px] text-slate-500">
            {live.taskName ?? live.taskId} · <span className="font-mono">{live.label}</span>
            {live.done && live.total ? ` · run ${live.done}/${live.total}` : ''}
          </span>
        </div>

        {live.steps.length === 0 ? (
          <p className="text-[11px] text-slate-600">Sandbox is up. Waiting for the first turn…</p>
        ) : (
          <div className="space-y-2">
            {live.steps.map((s) => <Step key={s.step} step={s} />)}
            <div ref={tail} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="overflow-y-auto p-4">
      <div className="flex items-baseline gap-2 mb-2 flex-wrap">
        <p className={heading}>Model output</p>

        {results.length > 1 && (
          <select
            className="bg-[var(--bark-900)] border border-[var(--bark-600)] rounded px-1 py-0.5 text-[10px] text-slate-300"
            value={index}
            onChange={(e) => setPick(Number(e.target.value))}
          >
            {results.map((r, i) => (
              <option key={i} value={i}>
                repeat {i + 1}/{results.length} · {r.verified ? 'verified' : 'failed'}
              </option>
            ))}
          </select>
        )}

        {shown && (
          <span className="text-[10px] text-slate-600">
            {shown.steps} steps · {shown.tokensUsed.toLocaleString()} tokens
          </span>
        )}
        {shown && (shown.verified
          ? <CheckCircle2 size={12} className="text-[var(--leaf-light)]" />
          : <XCircle size={12} className="text-red-400" />)}

        {shown?.conversation?.length && shown?.trace?.length ? (
          <div className="ml-auto flex items-center gap-1">
            {([['sent', 'Sent'], ['produced', 'Produced']] as const).map(([id, text]) => (
              <button
                key={id}
                onClick={() => setView(id)}
                title={id === 'sent'
                  ? 'Every message the model received, in order, tool results included'
                  : 'What the model generated each turn, reasoning included'}
                className={`text-[10px] px-1.5 py-0.5 rounded ${
                  view === id ? 'bg-[var(--bark-700)] text-slate-200' : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                {text}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {!shown && <p className="text-[11px] text-slate-600">This task and variant have not run yet.</p>}

      {shown?.error && (
        <p className="text-[11px] text-red-400 mb-2">{shown.error}</p>
      )}

      {shown && (() => {
        const useSent = view === 'sent' ? shown.conversation?.length : !shown.trace?.length;
        if (useSent && shown.conversation?.length) return <Conversation messages={shown.conversation} />;
        if (shown.trace?.length) return <div className="space-y-2">{shown.trace.map((s) => <Step key={s.step} step={s} />)}</div>;
        if (shown.conversation?.length) return <Conversation messages={shown.conversation} />;
        return <p className="text-[11px] text-slate-600">Nothing was recorded — this run predates capture.</p>;
      })()}

      {shown?.verifyOutput && (
        <div className="mt-3">
          <p className="text-[9px] uppercase tracking-widest text-slate-600">
            verify · exit {shown.verifyExitCode}
          </p>
          <pre className="text-[10px] text-slate-500 whitespace-pre-wrap">{shown.verifyOutput}</pre>
        </div>
      )}
    </div>
  );
}
