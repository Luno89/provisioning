import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Brain, Loader2, Play, Square, Wrench } from 'lucide-react'
import {
  ENGINE_EVENT_CHANNEL, answerRun, approveRunCall, cancelRun, engineKeys,
  listEngineAgents, primaryInput, startRun, type EngineAgent, type EngineEvent,
} from '../../api/engine'
import { errorMessage } from '../../api/client'
import { useSocketEvent } from '../../stores/socket'
import { emptyRunState, pendingApproval, reduceEngineEvent, type EngineRunState } from '../../lib/engine-run-state'
import TaskBoard from './TaskBoard'

export default function EngineRunView() {
  const [agent, setAgent] = useState('koala')
  const [message, setMessage] = useState('')
  const [runs, setRuns] = useState<EngineRunState[]>([])
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { data: agents = [] } = useQuery<EngineAgent[]>({
    queryKey: engineKeys.agents(),
    queryFn: listEngineAgents,
  })

  useSocketEvent<EngineEvent>(ENGINE_EVENT_CHANNEL, (event) => {
    setRuns((current) => {
      const known = current.some((run) => run.runId === event.runId)
      const withRun = known ? current : [...current, emptyRunState(event.runId)]
      return withRun.map((run) => (run.runId === event.runId ? reduceEngineEvent(run, event) : run))
    })
  })

  const selected = agents.find((option) => option.slug === agent)
  const { field, label } = primaryInput(selected)

  const send = async () => {
    if (!message.trim() || starting) return
    setStarting(true)
    setError(null)
    try {
      const started = await startRun({
        agent,
        message: message.trim(),
        inputs: { [field]: message.trim() },
      })
      setRuns((current) => (current.some((run) => run.runId === started.runId)
        ? current
        : [...current, emptyRunState(started.runId)]))
      setMessage('')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <header>
        <h2 className="text-lg font-semibold text-slate-100">Engine</h2>
        <p className="text-sm text-slate-400">
          Start an agent and watch it think. Every run here is durable — it survives a restart.
        </p>
      </header>

      <div className="flex gap-2">
        <select
          value={agent}
          onChange={(e) => setAgent(e.target.value)}
          className="bg-[var(--bark-900)] border border-[var(--bark-800)] rounded-md px-3 py-2 text-sm text-slate-200"
        >
          {agents.map((option) => (
            <option key={option.slug} value={option.slug}>
              {option.name}{option.mine ? ' (your copy)' : ''}
            </option>
          ))}
        </select>

        <input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }}
          placeholder={label}
          className="flex-1 bg-[var(--bark-900)] border border-[var(--bark-800)] rounded-md px-3 py-2 text-sm text-slate-200"
        />

        <button
          type="button"
          onClick={() => void send()}
          disabled={!message.trim() || starting}
          className="px-4 py-2 rounded-md bg-[var(--leaf-stem)]/20 text-[var(--leaf)] border border-[var(--leaf-stem)]/30 text-sm flex items-center gap-2 disabled:opacity-40"
        >
          {starting ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
          Run
        </button>
      </div>

      {error && (
        <div className="text-sm text-red-400 border border-red-500/30 bg-red-500/10 rounded-md px-3 py-2">
          {error}
        </div>
      )}

      <TaskBoard />

      {runs.length === 0 && (
        <p className="text-sm text-slate-500 italic">No runs yet.</p>
      )}

      {runs.map((run) => (
        <RunCard key={run.runId} run={run} />
      ))}
    </div>
  )
}

function RunCard({ run }: { run: EngineRunState }) {
  const approval = pendingApproval(run)
  const waiting = run.notices.filter((notice) => notice.level === 'info').at(-1)

  return (
    <section className="border border-[var(--bark-800)] rounded-lg bg-[var(--bark-900)]/40 p-4 space-y-3">
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
          <span className={`text-[11px] font-mono px-2 py-0.5 rounded ${
            run.outcome === 'ok'
              ? 'text-emerald-400 bg-emerald-500/10'
              : 'text-amber-400 bg-amber-500/10'
          }`}>
            {run.outcome}{run.outcomeReason ? ` — ${run.outcomeReason}` : ''}
          </span>
        )}
        {!run.finished && (
          <button
            type="button"
            onClick={() => void cancelRun(run.runId)}
            className="ml-auto text-[11px] text-slate-400 hover:text-slate-200 flex items-center gap-1"
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
          <pre className="px-3 pb-3 text-xs text-slate-400 whitespace-pre-wrap font-mono">{run.thinking}</pre>
        </details>
      )}

      {run.toolCalls.map((call) => (
        <div key={call.callId} className="text-xs flex items-start gap-2 text-slate-300">
          <Wrench size={12} className="mt-0.5 shrink-0 text-slate-500" />
          <div className="min-w-0">
            <span className="font-mono">{call.name}</span>
            {call.running
              ? <span className="text-slate-500"> · running…</span>
              : <span className={call.ok ? 'text-emerald-400' : 'text-red-400'}>{call.ok ? ' · ok' : ' · failed'}</span>}
            {call.digest && (
              <pre className="mt-1 text-[11px] text-slate-500 whitespace-pre-wrap font-mono">{call.digest}</pre>
            )}
          </div>
        </div>
      ))}

      {run.content && (
        <p className="text-sm text-slate-200 whitespace-pre-wrap">{run.content}</p>
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
              className="text-xs px-3 py-1 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
            >
              Allow
            </button>
            <button
              type="button"
              onClick={() => void approveRunCall(run.runId, { callId: lastCallId(run), allowed: true, forRun: true })}
              className="text-xs px-3 py-1 rounded bg-emerald-500/10 text-emerald-300/80 border border-emerald-500/20"
            >
              Allow for this run
            </button>
            <button
              type="button"
              onClick={() => void approveRunCall(run.runId, { callId: lastCallId(run), allowed: false })}
              className="text-xs px-3 py-1 rounded bg-red-500/20 text-red-300 border border-red-500/30"
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
          className="flex-1 bg-[var(--bark-900)] border border-[var(--bark-800)] rounded px-2 py-1 text-xs text-slate-200"
        />
        <button
          type="button"
          onClick={() => {
            if (!answer.trim() || !run.currentNode) return
            void answerRun(run.runId, run.currentNode, answer.trim())
            setAnswer('')
          }}
          className="text-xs px-3 py-1 rounded bg-[var(--leaf-stem)]/20 text-[var(--leaf)] border border-[var(--leaf-stem)]/30"
        >
          Answer
        </button>
      </div>
    </div>
  )
}

const lastCallId = (run: EngineRunState): string =>
  run.toolCalls.at(-1)?.callId ?? 'unknown'
