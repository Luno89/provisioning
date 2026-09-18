import { useState } from 'react'
import { Brain, Loader2, Square, Wrench } from 'lucide-react'
import { answerRun, approveRunCall, cancelRun } from '../../api/engine'
import { pendingApproval, type EngineRunState } from '../../lib/engine-run-state'

export default function RunCard({ run }: { run: EngineRunState }) {
  const approval = pendingApproval(run)
  const waiting = run.notices.filter((notice) => notice.level === 'info').at(-1)

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
        {!run.finished && (
          <button
            type="button"
            onClick={() => void cancelRun(run.runId)}
            className="ml-auto text-[11px] text-slate-400 hover:text-slate-200 flex items-center gap-1 cursor-pointer"
          >
            <Square size={10} /> Stop
          </button>
        )}
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

      {approval && !run.finished && (
        <div className="border border-amber-500/30 bg-amber-500/10 rounded-md p-3 space-y-2">
          <p className="text-xs text-amber-300">{approval}</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void approveRunCall(run.runId, { callId: lastCallId(run), allowed: true })}
              className="text-xs px-3 py-1 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/30 transition-colors"
            >
              Allow
            </button>
            <button
              type="button"
              onClick={() => void approveRunCall(run.runId, { callId: lastCallId(run), allowed: true, forRun: true })}
              className="text-xs px-3 py-1 rounded bg-emerald-500/10 text-emerald-300/80 border border-emerald-500/20 hover:bg-emerald-500/20 transition-colors"
            >
              Allow for this run
            </button>
            <button
              type="button"
              onClick={() => void approveRunCall(run.runId, { callId: lastCallId(run), allowed: false })}
              className="text-xs px-3 py-1 rounded bg-red-500/20 text-red-300 border border-red-500/30 hover:bg-red-500/30 transition-colors"
            >
              Decline
            </button>
          </div>
        </div>
      )}

      {waiting && !approval && !run.finished && run.currentNode && (
        <WaitingOnYou run={run} prompt={waiting.message} />
      )}
    </section>
  )
}

function WaitingOnYou({ run, prompt }: { run: EngineRunState; prompt: string }) {
  const [answer, setAnswer] = useState('')

  return (
    <div className="border border-[var(--bark-800)] rounded-md p-3 space-y-2">
      <p className="text-xs text-slate-300">{prompt}</p>
      <div className="flex gap-2">
        <input
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          placeholder="Your answer"
          className="flex-1 bg-[var(--bark-950)] border border-[var(--bark-800)] rounded px-2.5 py-1 text-xs text-slate-200 focus:outline-none focus:border-[var(--leaf-stem)]"
        />
        <button
          type="button"
          onClick={() => {
            if (!answer.trim() || !run.currentNode) return
            void answerRun(run.runId, run.currentNode, answer.trim())
            setAnswer('')
          }}
          className="text-xs px-3 py-1 rounded bg-[var(--leaf-stem)]/20 text-[var(--leaf)] border border-[var(--leaf-stem)]/30 hover:bg-[var(--leaf-stem)]/30 transition-colors cursor-pointer"
        >
          Answer
        </button>
      </div>
    </div>
  )
}

const lastCallId = (run: EngineRunState): string =>
  run.toolCalls.at(-1)?.callId ?? 'unknown'
