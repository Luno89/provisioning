import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Cpu, FlaskConical, Loader2, Play, Zap } from 'lucide-react'
import {
  ENGINE_EVENT_CHANNEL,
  engineKeys,
  listEngineAgents,
  primaryInput,
  startRun,
  type EngineAgent,
  type EngineEvent,
} from '../../api/engine'
import { errorMessage } from '../../api/client'
import { useSocketEvent } from '../../stores/socket'
import {
  emptyRunState,
  reduceEngineEvent,
  type EngineRunState,
} from '../../lib/engine-run-state'
import TaskBoard from './TaskBoard'
import RunCard from './RunCard'
import EvalsArea from '../Evals'
import ModelSelector from '../ModelSelector/ModelSelector'

export type EngineTab = 'live' | 'evals'

export interface EngineRunViewProps {
  initialTab?: EngineTab
}

export default function EngineRunView({ initialTab = 'live' }: EngineRunViewProps) {
  const [tab, setTab] = useState<EngineTab>(initialTab)

  // Live Run State
  const [agent, setAgent] = useState('koala')
  const [message, setMessage] = useState('')
  const [modelId, setModelId] = useState<string>('')
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
        ...(modelId ? { modelId } : {}),
      })
      setRuns((current) =>
        current.some((run) => run.runId === started.runId)
          ? current
          : [...current, emptyRunState(started.runId)],
      )
      setMessage('')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className={`p-6 mx-auto space-y-6 ${tab === 'evals' ? 'w-full max-w-none' : 'max-w-5xl'}`}>
      {/* Top Header & Navigation Tabs */}
      <header className="space-y-4">
        <div>
          <h1 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <Cpu size={22} className="text-[var(--leaf)]" />
            Agent Engine Platform
          </h1>
          <p className="text-sm text-slate-400 mt-0.5">
            Durable agent state machine execution, interactive tool approvals, and multi-turn verification.
          </p>
        </div>

        <nav className="flex items-center gap-2 border-b border-[var(--bark-800)] pb-px">
          <button
            type="button"
            onClick={() => setTab('live')}
            className={`px-4 py-2 text-xs font-medium rounded-t-md transition-all flex items-center gap-2 border-b-2 ${
              tab === 'live'
                ? 'border-[var(--leaf)] text-[var(--leaf)] bg-[var(--bark-900)]/80 font-semibold'
                : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-[var(--bark-900)]/40'
            }`}
          >
            <Zap size={14} /> Live Run
          </button>

          <button
            type="button"
            onClick={() => setTab('evals')}
            className={`px-4 py-2 text-xs font-medium rounded-t-md transition-all flex items-center gap-2 border-b-2 ${
              tab === 'evals'
                ? 'border-[var(--leaf)] text-[var(--leaf)] bg-[var(--bark-900)]/80 font-semibold'
                : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-[var(--bark-900)]/40'
            }`}
          >
            <FlaskConical size={14} /> Evals
          </button>
        </nav>
      </header>

      {/* Tab Contents */}
      {tab === 'evals' && <EvalsArea />}

      {tab === 'live' && (
        <div className="space-y-6">
          {/* Controls: Persona, Model Selector, Input */}
          <div className="bg-[var(--bark-900)]/60 border border-[var(--bark-800)] rounded-xl p-4 space-y-4 shadow-sm">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-400 font-medium">Persona:</span>
                <select
                  value={agent}
                  onChange={(e) => setAgent(e.target.value)}
                  className="bg-[var(--bark-950)] border border-[var(--bark-800)] rounded-md px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-[var(--leaf-stem)]"
                >
                  {agents.map((option) => (
                    <option key={option.slug} value={option.slug}>
                      {option.name}
                      {option.mine ? ' (your copy)' : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-400 font-medium">Model:</span>
                <ModelSelector
                  value={modelId}
                  onChange={(id) => {
                    setModelId(id)
                  }}
                  className="w-64"
                  placeholder="Account default model"
                />
              </div>
            </div>

            <div className="flex gap-2">
              <input
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void send()
                  }
                }}
                placeholder={label}
                className="flex-1 bg-[var(--bark-950)] border border-[var(--bark-800)] rounded-md px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-[var(--leaf-stem)] transition-colors placeholder:text-slate-500"
              />

              <button
                type="button"
                onClick={() => void send()}
                disabled={!message.trim() || starting}
                className="px-4 py-2 rounded-md bg-[var(--leaf-stem)]/20 text-[var(--leaf)] border border-[var(--leaf-stem)]/30 hover:bg-[var(--leaf-stem)]/30 text-xs font-semibold flex items-center gap-1.5 disabled:opacity-40 transition-all cursor-pointer"
              >
                {starting ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
                Run
              </button>
            </div>
          </div>

          {error && (
            <div className="text-xs text-red-400 border border-red-500/30 bg-red-500/10 rounded-md px-3 py-2">
              {error}
            </div>
          )}

          <TaskBoard />

          <div className="space-y-4">
            <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
              Execution Runs ({runs.length})
            </h3>

            {runs.length === 0 && (
              <div className="border border-[var(--bark-800)] rounded-lg bg-[var(--bark-900)]/30 p-8 text-center text-xs text-slate-500">
                No runs launched yet. Select an agent, configure an inference model, and run.
              </div>
            )}

            {runs.map((run) => (
              <RunCard key={run.runId} run={run} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
