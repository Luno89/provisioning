import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Loader2, Play } from 'lucide-react'
import { primaryInput, startRun, type EngineAgent, type EngineEvent } from '../../api/engine'
import { errorMessage } from '../../api/client'
import { useSocketEvent } from '../../stores/socket'
import { listRecentTurns, readTurn, turnKeys, TURN_LOG_CHANNEL } from '../../api/turns'
import { createTurnFollower } from '../../lib/turn-follower'
import type { TurnLogEntry } from '../../types/turns'
import { emptyRunState, reduceEngineEvent, type EngineRunState } from '../../lib/engine-run-state'
import RunCard from '../EngineRun/RunCard'
import ModelSelector from '../ModelSelector/ModelSelector'

export default function AgentTryIt({ agent }: { agent: EngineAgent | undefined }) {
  return agent ? <TryIt agent={agent} /> : <p className="text-xs text-slate-500">Loading the agent…</p>
}

function TryIt({ agent }: { agent: EngineAgent }) {
  const [message, setMessage] = useState('')
  const [modelId, setModelId] = useState('')
  const [runs, setRuns] = useState<EngineRunState[]>([])
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const follower = useRef(createTurnFollower(readTurn))
  const apply = useCallback((entry: TurnLogEntry) => {
    setRuns((current) => entry.events.reduce((all: EngineRunState[], event: EngineEvent) => {
      const withRun = all.some((run) => run.runId === event.runId) ? all : [...all, emptyRunState(event.runId)]
      return withRun.map((run) => (run.runId === event.runId ? reduceEngineEvent(run, event) : run))
    }, current))
  }, [])
  const follow = useCallback((turnId: string) => {
    if (follower.current.following(turnId)) return
    setRuns((current) => (current.some((run) => run.runId === turnId) ? current : [...current, emptyRunState(turnId)]))
    void follower.current.follow(turnId, apply).catch((err) => setError(`Could not read run ${turnId}: ${errorMessage(err)}`))
  }, [apply])

  const { data: recent = [] } = useQuery({ queryKey: turnKeys.recent(), queryFn: listRecentTurns })
  useEffect(() => {
    for (const turn of [...recent].reverse()) if (turn.agentId === agent.slug) follow(turn.turnId)
  }, [recent, follow, agent.slug])

  useSocketEvent<TurnLogEntry>(TURN_LOG_CHANNEL, (entry) => follower.current.receive(entry, apply))

  const { field, label } = primaryInput(agent)
  const mine = runs.filter((run) => !run.agentId || run.agentId === agent.slug)

  const send = async () => {
    if (!message.trim() || starting) return
    setStarting(true)
    setError(null)
    try {
      const started = await startRun({ agent: agent.slug, message: message.trim(), inputs: { [field]: message.trim() }, ...(modelId ? { modelId } : {}) })
      follow(started.runId)
      setMessage('')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-xl border border-[var(--bark-800)] bg-[var(--bark-900)]/60 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-slate-400">Model</span>
          <ModelSelector value={modelId} onChange={setModelId} className="w-64" placeholder="Account default model" />
        </div>
        <div className="flex gap-2">
          <input
            aria-label={`What to ask ${agent.name}`}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void send()
              }
            }}
            placeholder={label}
            className="flex-1 rounded-md border border-[var(--bark-800)] bg-[var(--bark-950)] px-3 py-2 text-xs text-slate-200 placeholder:text-slate-500 focus:border-[var(--leaf-stem)] focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={!message.trim() || starting}
            className="flex items-center gap-1.5 rounded-md border border-[var(--leaf-stem)]/30 bg-[var(--leaf-stem)]/20 px-4 py-2 text-xs font-semibold text-[var(--leaf)] hover:bg-[var(--leaf-stem)]/30 disabled:opacity-40"
          >
            {starting ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} Run
          </button>
        </div>
      </div>

      {error && <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</p>}

      {mine.length === 0 && <p className="text-xs text-slate-500">No runs of {agent.name} yet.</p>}
      {[...mine].reverse().map((run) => <RunCard key={run.runId} run={run} />)}
    </div>
  )
}
