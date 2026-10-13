import { Brain, Loader2, Wrench } from 'lucide-react'
import type { EngineRunState } from '../../lib/engine-run-state'
import RunControls, { StopRun } from './RunControls'

export default function RunCard({ run }: { run: EngineRunState }) {
  return (
    <section className="border border-[var(--bark-800)] rounded-lg bg-[var(--bark-900)]/40 p-4 space-y-3 shadow-sm">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-mono text-xs text-slate-400">{run.runId}</span>
        {run.agentId && (
          <span className="text-[11px] font-mono bg-[var(--bark-800)] px-2 py-0.5 rounded text-slate-300">
            {run.agentId} · {run.loopId}
          </span>
        )}
        {run.currentNode && !run.finished && (
          <span className="text-[11px] font-mono text-[var(--leaf)] flex items-center gap-1">
            <Loader2 size={10} className="animate-spin" /> {run.currentNode}
          </span>
        )}
        {run.finished && (
          <span
            className={`text-[11px] font-mono px-2 py-0.5 rounded ${
              run.outcome === 'ok'
                ? 'text-emerald-400 bg-emerald-500/10'
                : 'text-amber-400 bg-amber-500/10'
            }`}
          >
            {run.outcome}
            {run.outcomeReason ? ` — ${run.outcomeReason}` : ''}
          </span>
        )}
        <StopRun run={run} />
      </div>

      {run.visited.length > 0 && (
        <div className="text-[11px] font-mono text-slate-500">
          {run.visited.join(' → ')}
        </div>
      )}

      {run.thinking && (
        <details open className="border border-[var(--bark-800)] rounded-md">
          <summary className="px-3 py-2 text-xs text-slate-400 cursor-pointer flex items-center gap-2">
            <Brain size={12} /> Thinking
          </summary>
          <pre className="px-3 pb-3 text-xs text-slate-400 whitespace-pre-wrap font-mono">
            {run.thinking}
          </pre>
        </details>
      )}

      {run.toolCalls.map((call) => (
        <div key={call.callId} className="text-xs flex items-start gap-2 text-slate-300">
          <Wrench size={12} className="mt-0.5 shrink-0 text-slate-500" />
          <div className="min-w-0">
            <span className="font-mono font-medium">{call.name}</span>
            {call.running ? (
              <span className="text-slate-500"> · running…</span>
            ) : (
              <span className={call.ok ? 'text-emerald-400' : 'text-red-400'}>
                {call.ok ? ' · ok' : ' · failed'}
              </span>
            )}
            {call.digest && (
              <pre className="mt-1 text-[11px] text-slate-400 whitespace-pre-wrap font-mono bg-[var(--bark-950)] p-1.5 rounded">
                {call.digest}
              </pre>
            )}
          </div>
        </div>
      ))}

      {run.content && (
        <p className="text-xs text-slate-200 whitespace-pre-wrap leading-relaxed">
          {run.content}
        </p>
      )}

      {run.interruptedReason && (
        <p className="text-xs text-amber-400">Interrupted: {run.interruptedReason}</p>
      )}

      <RunControls run={run} />
    </section>
  )
}
