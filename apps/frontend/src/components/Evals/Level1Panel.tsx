import { useState } from 'react'
import CaseTree from './CaseTree'
import CaseDetail from './CaseDetail'
import CaseEditor from './CaseEditor'
import ModelSelector from '../ModelSelector/ModelSelector'
import { failingNames, groupCases, tally } from '../../lib/eval-tree'
import { outcomesOf, runLabel, summaryOf } from '../../lib/level1-run'
import {
  fieldClass,
  panelClass,
  primaryButton,
  quietButton,
  useCancelLevel1Run,
  useCases,
  useDeleteCase,
  useLevel1Run,
  useLevel1Runs,
  useModels,
  useSelection,
  useStartLevel1Run,
} from './shared'

export default function Level1Panel() {
  const cases = useCases()
  const runs = useLevel1Runs()
  const models = useModels()

  const [chosenRunId, setChosenRunId] = useState<string>()
  const runId = chosenRunId ?? runs.data?.[0]?.id
  const run = useLevel1Run(runId)
  const start = useStartLevel1Run((started) => setChosenRunId(started.id))
  const cancel = useCancelLevel1Run()
  const [openCase, setOpenCase] = useState<string>()
  const [editing, setEditing] = useState<{ name: string | null } | undefined>()
  const remove = useDeleteCase(() => setOpenCase(undefined))

  const [repeats, setRepeats] = useState(5)
  const [temperature, setTemperature] = useState('')
  const [maxTokens, setMaxTokens] = useState('')
  const [modelId, setModelId] = useState('')
  const [filter, setFilter] = useState<'all' | 'problems'>('all')

  const entries = cases.data?.cases ?? []
  const gaps = cases.data?.coverage ?? []
  const uncovered = gaps.filter((gap) => gap.kind !== 'unprovoked')
  const unprovoked = gaps.filter((gap) => gap.kind === 'unprovoked')
  const selection = useSelection(entries.map((entry) => entry.name))
  const chosen = selection.chosen
  const busy = run.data?.state === 'running'
  const agents = [...new Set(entries.map((entry) => entry.agent))].sort()

  const groups = groupCases(entries.map(summaryOf), outcomesOf(run.data), run.data?.running)
  const counts = tally(groups)
  const failing = failingNames(groups)
  const selected = entries.find((entry) => entry.name === openCase)
  const editingEntry = editing?.name ? entries.find((entry) => entry.name === editing.name) : undefined

  const launch = (only?: string[]) => start.mutate({
    repeats,
    ...(temperature.trim() ? { temperature: Number(temperature) } : {}),
    ...(maxTokens.trim() ? { maxTokens: Number(maxTokens) } : {}),
    ...(only ? { only } : selection.everything ? {} : { only: chosen }),
    ...(modelId ? { modelId, modelLabel: models.data?.find((entry) => entry.id === modelId)?.name ?? modelId } : {}),
  })

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-slate-400">
        Give a persona only its tool package and see whether it calls the right thing. Every case runs
        through the same Model Turn a real run uses, several times, because a tool that works four
        times in five is not a tool that works.
      </p>

      {runs.data && runs.data.length > 0 && (
        <section className="flex flex-wrap items-center justify-between gap-3 rounded border border-slate-800 bg-slate-900/60 px-4 py-2 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Past runs</span>
            <select
              aria-label="Select past eval run"
              value={runId ?? ''}
              onChange={(event) => setChosenRunId(event.target.value)}
              className="rounded border border-slate-700 bg-slate-950 px-2.5 py-1 text-xs text-slate-200"
            >
              {runs.data.map((past) => <option key={past.id} value={past.id}>{runLabel(past)}</option>)}
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
          disabled={busy || start.isPending || chosen.length === 0}
          onClick={() => launch()}
          className={primaryButton}
        >
          {busy ? 'Running…' : `Run ${chosen.length} case${chosen.length === 1 ? '' : 's'}`}
        </button>

        <div className="flex items-center gap-2 text-sm text-slate-400">
          <span>Model</span>
          <ModelSelector value={modelId} onChange={setModelId} className="w-56" placeholder="Account default" />
        </div>

        {models.data?.length === 0 && (
          <span className="text-sm text-amber-400">No models are set up yet — deploy one or add an endpoint first.</span>
        )}

        <label className="flex items-center gap-2 text-sm text-slate-400">
          Repeats
          <input
            type="number" min={1} max={25} value={repeats}
            onChange={(event) => setRepeats(Number(event.target.value))}
            className={`w-16 ${fieldClass}`}
          />
        </label>

        <label className="flex items-center gap-2 text-sm text-slate-400" title="Blank uses whatever sampling the persona itself declares">
          Temp
          <input
            type="number" step={0.1} min={0} max={2} placeholder="auto" value={temperature}
            onChange={(event) => setTemperature(event.target.value)}
            className={`w-20 ${fieldClass}`}
          />
        </label>

        <label className="flex items-center gap-2 text-sm text-slate-400" title="Blank uses the engine default">
          Reply tokens
          <input
            type="number" step={256} min={256} max={32000} placeholder="auto" value={maxTokens}
            onChange={(event) => setMaxTokens(event.target.value)}
            className={`w-24 ${fieldClass}`}
          />
        </label>

        <div className="flex gap-2 text-sm">
          <button type="button" onClick={selection.all} className="text-sky-400 hover:underline">All</button>
          <button type="button" onClick={selection.none} className="text-slate-500 hover:underline">None</button>
        </div>

        <button type="button" onClick={() => setEditing({ name: null })} className={`ml-auto ${quietButton}`}>
          New case
        </button>

        {busy && runId && (
          <button type="button" onClick={() => cancel.mutate(runId)} className={quietButton}>Stop</button>
        )}
      </section>

      <section className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded border border-slate-800 bg-slate-950 px-4 py-3">
        <span className="flex gap-3 font-mono text-sm">
          <span className="text-emerald-400" aria-label={`${counts.pass} passed`}>{counts.pass} ✓</span>
          <span className="text-amber-400" aria-label={`${counts.flaky} flaky`}>{counts.flaky} ~</span>
          <span className="text-rose-400" aria-label={`${counts.fail} failed`}>{counts.fail} ✕</span>
          <span className="text-slate-600" aria-label={`${counts.pending} not run`}>{counts.pending} ·</span>
        </span>

        {run.data && (
          <span className="text-xs text-slate-500">
            {run.data.finished}/{run.data.cases.length} cases
            {run.data.running ? ` · ${run.data.running}` : ''}
            {run.data.modelLabel ? ` · ${run.data.modelLabel}` : ''}
          </span>
        )}

        {busy && (
          <span className="h-1 min-w-[6rem] flex-1 overflow-hidden rounded bg-slate-800">
            <span
              className="block h-full bg-sky-500 transition-all"
              style={{ width: `${Math.round(((run.data?.finished ?? 0) / Math.max(1, run.data?.cases.length ?? 1)) * 100)}%` }}
            />
          </span>
        )}

        <div className="ml-auto flex items-center gap-2 text-xs">
          <button type="button" onClick={() => setFilter('all')} className={filter === 'all' ? 'text-sky-400' : 'text-slate-500 hover:text-slate-300'}>All</button>
          <button type="button" onClick={() => setFilter('problems')} className={filter === 'problems' ? 'text-sky-400' : 'text-slate-500 hover:text-slate-300'}>Problems</button>
          <button
            type="button"
            disabled={busy || failing.length === 0}
            onClick={() => launch(failing)}
            className="text-slate-500 hover:text-sky-400 disabled:opacity-40"
          >
            Re-run {failing.length} failing
          </button>
        </div>
      </section>

      {run.data?.error && (
        <p className="rounded border border-rose-900 bg-rose-950/40 p-3 text-sm text-rose-300">{run.data.error}</p>
      )}

      {editing && (
        <CaseEditor
          entry={editingEntry}
          agents={agents}
          onClose={() => setEditing(undefined)}
          onSaved={(entry) => {
            setEditing(undefined)
            setOpenCase(entry.name)
          }}
        />
      )}

      {selected && !editing && (
        <CaseDetail
          entry={selected}
          run={run.data}
          onEdit={() => setEditing({ name: selected.name })}
          onDelete={() => remove.mutate(selected.name)}
          onRun={() => launch([selected.name])}
          onClose={() => setOpenCase(undefined)}
        />
      )}

      {run.data && run.data.summary.tools.length > 0 && (
        <section className={panelClass}>
          <h2 className="mb-3 text-sm font-semibold text-slate-300">How reliably each tool was chosen</h2>
          <ul className="space-y-2">
            {run.data.summary.tools.map((score) => (
              <li key={score.tool} className="flex flex-wrap items-baseline gap-2 text-sm">
                <span className="font-mono text-xs text-slate-200">{score.tool}</span>
                <span className={score.passed === score.attempts ? 'text-emerald-400' : score.passed === 0 ? 'text-rose-400' : 'text-amber-400'}>
                  {score.passed}/{score.attempts}
                </span>
                <span className="text-xs text-slate-500">across {score.cases} case{score.cases === 1 ? '' : 's'}</span>
                {score.complaints.length > 0 && (
                  <span className="w-full pl-4 font-mono text-xs text-rose-300/80">{score.complaints.join(' · ')}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {uncovered.length > 0 && (
        <details className="rounded border border-amber-900/60 bg-amber-950/20 p-4">
          <summary className="cursor-pointer text-sm text-amber-300">
            {uncovered.length} tool{uncovered.length === 1 ? '' : 's'} no case calls
          </summary>
          <ul className="mt-2 space-y-1">
            {uncovered.map((gap) => (
              <li key={`${gap.case}-${gap.message}`} className="text-sm text-amber-200/80">
                <span className="font-mono text-xs">{gap.case}</span> {gap.message}
              </li>
            ))}
          </ul>
        </details>
      )}

      {unprovoked.length > 0 && (
        <details className="rounded border border-slate-800 bg-slate-900/30 p-4">
          <summary className="cursor-pointer text-sm text-slate-400">
            {unprovoked.length} things nothing checks yet
          </summary>
          <ul className="mt-2 space-y-1">
            {unprovoked.map((gap) => (
              <li key={`${gap.case}-${gap.message}`} className="text-sm text-slate-400">
                <span className="font-mono text-xs">{gap.case}</span> {gap.message}
              </li>
            ))}
          </ul>
        </details>
      )}

      {cases.isLoading && <p className="text-sm text-slate-500">Loading cases…</p>}
      {cases.isError && <p className="text-sm text-rose-400">Could not load the cases.</p>}

      {cases.data && (
        <CaseTree
          groups={groups}
          filter={filter}
          isChosen={selection.isChosen}
          onToggle={selection.toggle}
          onRunOnly={launch}
          onOpen={(name) => setOpenCase(name === openCase ? undefined : name)}
        />
      )}
    </div>
  )
}
