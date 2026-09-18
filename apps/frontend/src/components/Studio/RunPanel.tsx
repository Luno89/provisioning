import { useState } from 'react'
import { CircleAlert, Crosshair, Loader2, Play } from 'lucide-react'
import type { NodeTrace, Procedure } from '@koala/agent-engine/procedure'
import { primaryInput, startRun, type EngineEvent } from '../../api/engine'
import { reduceEngineEvents } from '../../lib/engine-run-state'
import ModelSelector from '../ModelSelector/ModelSelector'
import RunCard from '../EngineRun/RunCard'
import { errorMessage, useEngineAgents } from './shared'

export interface StudioRun {
  runId: string
  events: EngineEvent[]
}

export interface RunPanelProps {
  procedure: Procedure
  blockedBecause: string | undefined
  runs: readonly StudioRun[]
  activeRunId: string | undefined
  traces: readonly NodeTrace[]
  replayAt: number | undefined
  onStarted: (runId: string) => void
  onPickRun: (runId: string) => void
  onReplay: (trace: NodeTrace | undefined) => void
}

const field = 'rounded-md border border-[var(--bark-700)] bg-[var(--bark-900)] px-2 py-1 text-xs text-slate-200 outline-none focus:border-[var(--leaf-stem)]'

function Json({ value }: { value: unknown }) {
  if (value === undefined) return <span className="text-slate-600">nothing</span>
  return <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--bark-950,#0d0f0d)] p-2 font-mono text-[10px] text-slate-300">{JSON.stringify(value, null, 2)}</pre>
}

export default function RunPanel({ procedure, blockedBecause, runs, activeRunId, traces, replayAt, onStarted, onPickRun, onReplay }: RunPanelProps) {
  const { data: agents = [] } = useEngineAgents()
  const [agentChoice, setAgentChoice] = useState<string>()
  const [modelId, setModelId] = useState('')
  const [message, setMessage] = useState('')
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const agent = agentChoice ?? agents.find((candidate) => candidate.loop === procedure.id)?.slug ?? agents[0]?.slug ?? ''
  const { field: inputName, label } = primaryInput(agents.find((candidate) => candidate.slug === agent))

  const active = runs.find((run) => run.runId === activeRunId)
  const state = active ? reduceEngineEvents(active.runId, active.events) : undefined
  const focused = traces.find((trace) => trace.sequence === replayAt)

  const run = async () => {
    if (!message.trim() || !agent || starting || blockedBecause) return
    setStarting(true)
    setError(null)
    try {
      const started = await startRun({
        agent,
        message: message.trim(),
        inputs: { [inputName]: message.trim() },
        procedure: procedure.id,
        ...(modelId ? { modelId } : {}),
      })
      onStarted(started.runId)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 overflow-x-auto">
      <div className="flex w-[24rem] min-w-[18rem] shrink flex-col gap-2 overflow-y-auto border-r border-[var(--bark-700)] p-2">
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-[11px] text-slate-400">
            As
            <select aria-label="Run as agent" className={field} value={agent} onChange={(event) => setAgentChoice(event.target.value)}>
              {agents.map((option) => <option key={option.slug} value={option.slug}>{option.name}</option>)}
            </select>
          </label>
          <ModelSelector value={modelId} onChange={(id) => setModelId(id)} className="w-52" placeholder="Account default model" />
        </div>
        <div className="flex gap-1.5">
          <input
            aria-label="Run message"
            className={`${field} flex-1`}
            value={message}
            placeholder={label}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void run()
              }
            }}
          />
          <button
            type="button"
            onClick={() => void run()}
            disabled={!message.trim() || !agent || starting || Boolean(blockedBecause)}
            title={blockedBecause}
            className="flex items-center gap-1 rounded-md border border-[var(--leaf-stem)]/40 bg-[var(--leaf-stem)]/20 px-3 py-1 text-xs font-semibold text-[var(--leaf-light)] hover:bg-[var(--leaf-stem)]/30 disabled:opacity-40"
          >
            {starting ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} Run
          </button>
        </div>
        {blockedBecause && <p className="text-[11px] text-amber-300">{blockedBecause}</p>}
        {error && <p className="text-[11px] text-red-300">{error}</p>}

        {runs.length > 1 && (
          <select aria-label="Pick a run" className={field} value={activeRunId} onChange={(event) => onPickRun(event.target.value)}>
            {runs.map((entry, index) => <option key={entry.runId} value={entry.runId}>Run {index + 1} · {entry.runId}</option>)}
          </select>
        )}
        {state && <RunCard run={state} />}
        {!state && <p className="text-[11px] text-slate-500">Runs the saved version of this procedure. Nodes light up on the canvas as they run; afterwards, click a step on the right to see what went in and came out.</p>}
      </div>

      <div className="flex min-w-[28rem] flex-1">
        <ol className="w-60 shrink-0 overflow-y-auto border-r border-[var(--bark-700)] p-1 text-[11px]" aria-label="Trace">
          {traces.length === 0 && <li className="p-2 text-slate-500">{active ? 'Waiting for the first node…' : 'No run yet.'}</li>}
          {traces.map((trace) => (
            <li key={trace.sequence}>
              <button
                type="button"
                onClick={() => onReplay(replayAt === trace.sequence ? undefined : trace)}
                className={`flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left ${replayAt === trace.sequence ? 'bg-sky-500/20' : 'hover:bg-[var(--bark-800)]'} ${trace.role === 'value' ? 'text-slate-500' : 'text-slate-200'}`}
              >
                <span className="w-6 shrink-0 text-right font-mono text-[10px] text-slate-600">{trace.sequence}</span>
                {trace.error && <CircleAlert size={11} className="shrink-0 text-red-400" />}
                <span className="truncate font-mono">{trace.node}</span>
                {trace.exit && <span className="truncate text-sky-300">→ {trace.exit}</span>}
                <span className="ml-auto shrink-0 font-mono text-[10px] text-slate-600">{trace.durationMs}ms</span>
              </button>
            </li>
          ))}
        </ol>
        <div className="min-w-0 flex-1 overflow-y-auto p-2 text-[11px]">
          {!focused && <p className="text-slate-500">Pick a node in the trace to see its inputs and outputs, and where it sits on the canvas.</p>}
          {focused && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="font-mono text-slate-100">{focused.node}</span>
                <span className="text-slate-500">{focused.kind} · {focused.role} · step {focused.step}{focused.cleanup ? ' · cleanup' : ''}</span>
                <button type="button" onClick={() => onReplay(focused)} className="ml-auto flex items-center gap-1 text-sky-300 hover:underline">
                  <Crosshair size={11} /> Show on canvas
                </button>
              </div>
              {focused.error && <p className="text-red-300">Failed: {focused.error}</p>}
              {focused.interrupted && <p className="text-amber-300">Interrupted: {focused.interrupted}</p>}
              {focused.finish && <p className="text-slate-300">Finished the run: {focused.finish.outcome}{focused.finish.reason ? ` — ${focused.finish.reason}` : ''}</p>}
              <div>
                <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">Went in</h4>
                <Json value={focused.inputs} />
              </div>
              <div>
                <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">Came out</h4>
                <Json value={focused.outputs} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
