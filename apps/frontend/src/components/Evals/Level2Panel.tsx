import { useState } from 'react'
import ModelSelector from '../ModelSelector/ModelSelector'
import ScenarioEditor from './ScenarioEditor'
import ScenarioTrace from './ScenarioTrace'
import { useProcedureList } from '../Studio/shared'
import type { ScenarioResult } from '../../api/evals'
import {
  fieldClass,
  panelClass,
  primaryButton,
  quietButton,
  useCancelLevel2Run,
  useDeleteScenario,
  useLevel2Run,
  useLevel2Runs,
  useModels,
  useScenarios,
  useSelection,
  useStartLevel2Run,
} from './shared'

const tone = (passed: boolean) => (passed ? 'text-emerald-400' : 'text-rose-400')

function Result({ result }: { result: ScenarioResult }) {
  const [open, setOpen] = useState(false)

  return (
    <li className="border-t border-slate-800 first:border-t-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-slate-900/40"
      >
        <span className={`w-4 shrink-0 text-center ${tone(result.passed)}`}>{result.passed ? '✓' : '✕'}</span>
        <span className="min-w-0 flex-1 truncate text-sm text-slate-200">{result.name}</span>
        <span className="shrink-0 font-mono text-xs text-slate-500">
          {result.checks.filter((check) => check.passed).length}/{result.checks.length} checks
        </span>
        <span className="shrink-0 font-mono text-xs text-slate-600">
          {result.counters.rounds} rounds · {result.counters.toolCalls} calls · {Math.round(result.durationMs / 100) / 10}s
        </span>
      </button>

      {open && (
        <div className="min-w-0 space-y-3 overflow-hidden border-l-2 border-slate-800 px-4 py-3">
          <ul className="space-y-1">
            {result.checks.map((check) => (
              <li key={check.what} className="flex gap-2 text-xs">
                <span className={`w-3 shrink-0 ${tone(check.passed)}`}>{check.passed ? '✓' : '✕'}</span>
                <span className="text-slate-300">{check.what}</span>
                <span className="text-slate-500">{check.detail}</span>
              </li>
            ))}
          </ul>

          {result.error && <p className="font-mono text-xs text-rose-300">{result.error}</p>}

          {result.answer && (
            <div>
              <p className="text-[10px] uppercase tracking-wide text-slate-500">What it answered</p>
              <p className="whitespace-pre-wrap text-xs text-slate-400">{result.answer}</p>
            </div>
          )}

          {result.calls.length > 0 && (
            <div>
              <p className="text-[10px] uppercase tracking-wide text-slate-500">Tools it called</p>
              <ol className="space-y-0.5">
                {result.calls.map((call, index) => (
                  <li key={`${call.name}-${index}`} className="flex min-w-0 gap-2 font-mono text-xs">
                    <span className={`shrink-0 ${call.ok ? 'text-slate-400' : 'text-rose-400'}`}>{call.name}</span>
                    <span className="min-w-0 truncate text-slate-600">{call.digest}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {result.tasks.length > 0 && (
            <div>
              <p className="text-[10px] uppercase tracking-wide text-slate-500">Tasks it left behind</p>
              <ul className="space-y-0.5">
                {result.tasks.map((task) => (
                  <li key={task.id} className="text-xs text-slate-400">
                    <span className="font-mono text-slate-300">{task.status}</span> {task.title}
                    {task.evidence ? <span className="text-slate-600"> — {task.evidence}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <ScenarioTrace result={result} />
        </div>
      )}
    </li>
  )
}

export default function Level2Panel() {
  const scenarios = useScenarios()
  const runs = useLevel2Runs()
  const models = useModels()
  const procedures = useProcedureList()

  const [chosenRunId, setChosenRunId] = useState<string>()
  const runId = chosenRunId ?? runs.data?.[0]?.id
  const run = useLevel2Run(runId)
  const start = useStartLevel2Run((started) => setChosenRunId(started.id))
  const cancel = useCancelLevel2Run()
  const [editing, setEditing] = useState<{ id: string | null }>()
  const remove = useDeleteScenario()
  const [modelId, setModelId] = useState('')
  const [temperature, setTemperature] = useState('')

  const all = scenarios.data ?? []
  const selection = useSelection(all.map((scenario) => scenario.id))
  const busy = run.data?.state === 'running'
  const editingScenario = editing?.id ? all.find((scenario) => scenario.id === editing.id) : undefined
  const agents = [...new Set(all.map((scenario) => scenario.agent))].sort()
  const procedureIds = (procedures.data?.procedures ?? []).map((entry) => entry.id)

  const launch = (only?: string[]) => start.mutate({
    ...(only ? { only } : selection.everything ? {} : { only: selection.chosen }),
    ...(temperature.trim() ? { temperature: Number(temperature) } : {}),
    ...(modelId ? { modelId, modelLabel: models.data?.find((entry) => entry.id === modelId)?.name ?? modelId } : {}),
  })

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-slate-400">
        A whole procedure runs against a throwaway world — real tools, a real sandbox, its own tasks
        and files — and what it did is scored check by check.
      </p>

      {runs.data && runs.data.length > 0 && (
        <section className="flex flex-wrap items-center justify-between gap-3 rounded border border-slate-800 bg-slate-900/60 px-4 py-2 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Past runs</span>
            <select
              aria-label="Select past scenario run"
              value={runId ?? ''}
              onChange={(event) => setChosenRunId(event.target.value)}
              className="rounded border border-slate-700 bg-slate-950 px-2.5 py-1 text-xs text-slate-200"
            >
              {runs.data.map((past) => (
                <option key={past.id} value={past.id}>
                  {new Date(past.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  {' · '}{past.modelLabel ?? past.modelId ?? 'Account default'}
                  {' · '}{past.results.filter((result) => result.passed).length}/{past.scenarios.length} passed
                  {' · '}{past.state}
                </option>
              ))}
            </select>
          </div>
          {chosenRunId && (
            <button type="button" onClick={() => setChosenRunId(undefined)} className="text-xs text-sky-400 hover:underline">
              Show latest run
            </button>
          )}
        </section>
      )}

      <section className={`flex flex-wrap items-center gap-3 ${panelClass}`}>
        <button
          type="button"
          disabled={busy || start.isPending || selection.chosen.length === 0}
          onClick={() => launch()}
          className={primaryButton}
        >
          {busy ? 'Running…' : `Run ${selection.chosen.length} scenario${selection.chosen.length === 1 ? '' : 's'}`}
        </button>

        <div className="flex items-center gap-2 text-sm text-slate-400">
          <span>Model</span>
          <ModelSelector value={modelId} onChange={setModelId} className="w-56" placeholder="Account default" />
        </div>

        <label className="flex items-center gap-2 text-sm text-slate-400" title="Blank uses whatever sampling the persona declares">
          Temp
          <input
            type="number" step={0.1} min={0} max={2} placeholder="auto" value={temperature}
            onChange={(event) => setTemperature(event.target.value)}
            className={`w-20 ${fieldClass}`}
          />
        </label>

        <div className="flex gap-2 text-sm">
          <button type="button" onClick={selection.all} className="text-sky-400 hover:underline">All</button>
          <button type="button" onClick={selection.none} className="text-slate-500 hover:underline">None</button>
        </div>

        <button type="button" onClick={() => setEditing({ id: null })} className={`ml-auto ${quietButton}`}>
          New scenario
        </button>

        {busy && runId && (
          <button type="button" onClick={() => cancel.mutate(runId)} className={quietButton}>Stop</button>
        )}
      </section>

      {run.data?.error && (
        <p className="rounded border border-rose-900 bg-rose-950/40 p-3 text-sm text-rose-300">{run.data.error}</p>
      )}

      {editing && (
        <ScenarioEditor
          scenario={editingScenario}
          agents={agents}
          procedures={procedureIds}
          onClose={() => setEditing(undefined)}
          onSaved={() => setEditing(undefined)}
        />
      )}

      <section className="rounded border border-slate-800">
        <header className="flex items-center gap-3 border-b border-slate-800 bg-slate-900/60 px-3 py-2 text-xs text-slate-400">
          <span className="font-semibold uppercase tracking-wider">Scenarios</span>
          {run.data && (
            <span>
              {run.data.finished}/{run.data.scenarios.length} run
              {run.data.running ? ` · ${run.data.running}` : ''}
            </span>
          )}
        </header>

        {scenarios.isLoading && <p className="px-3 py-2 text-sm text-slate-500">Loading scenarios…</p>}
        {scenarios.isError && <p className="px-3 py-2 text-sm text-rose-400">Could not load the scenarios.</p>}

        <ul className="divide-y divide-slate-800">
          {all.map((scenario) => {
            const result = run.data?.results.find((entry) => entry.scenarioId === scenario.id)
            const running = run.data?.running === scenario.id

            return (
              <li key={scenario.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <input
                  type="checkbox"
                  className="accent-sky-500"
                  checked={selection.isChosen(scenario.id)}
                  onChange={() => selection.toggle(scenario.id)}
                  aria-label={`Include ${scenario.name}`}
                />
                <span className={`w-4 text-center ${running ? 'animate-pulse text-sky-400' : result ? tone(result.passed) : 'text-slate-600'}`}>
                  {running ? '◌' : result ? (result.passed ? '✓' : '✕') : '·'}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-slate-200">{scenario.name}</span>
                  <span className="block truncate text-xs text-slate-500">{scenario.describe}</span>
                </span>
                <span className="font-mono text-xs text-slate-600">{scenario.agent} · {scenario.procedure.id}</span>
                <button type="button" onClick={() => launch([scenario.id])} className="text-xs text-slate-500 hover:text-sky-400">run</button>
                <button type="button" onClick={() => setEditing({ id: scenario.id })} className="text-xs text-slate-500 hover:text-sky-400">
                  {scenario.mine ? 'edit' : 'copy'}
                </button>
                {scenario.mine && (
                  <button type="button" onClick={() => remove.mutate(scenario.id)} className="text-xs text-slate-500 hover:text-rose-400">
                    delete
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      </section>

      {run.data && run.data.results.length > 0 && (
        <section className="rounded border border-slate-800">
          <header className="border-b border-slate-800 bg-slate-900/60 px-3 py-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
            What happened
          </header>
          <ul>
            {run.data.results.map((result) => <Result key={result.scenarioId} result={result} />)}
          </ul>
        </section>
      )}
    </div>
  )
}
