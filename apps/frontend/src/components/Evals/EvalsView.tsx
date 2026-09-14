import { useState } from 'react'
import CaseList from './CaseList'
import { useCancelRun, useCases, useModels, useRun, useSelection, useStartRun } from './shared'

export default function EvalsView() {
  const cases = useCases()
  const [runId, setRunId] = useState<string>()
  const run = useRun(runId)
  const start = useStartRun((started) => setRunId(started.id))
  const cancel = useCancelRun()
  const [repeats, setRepeats] = useState(5)
  const models = useModels()
  const [modelId, setModelId] = useState('')
  const chosenModel = models.data?.find((entry) => entry.id === modelId)

  const names = cases.data?.cases.map((entry) => entry.name) ?? []
  const selection = useSelection(names)
  const chosen = selection.chosen
  const busy = run.data?.state === 'running'

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-slate-100">Tool evals</h1>
        <p className="text-sm text-slate-400">
          Give an agent only its tool package and see whether it calls the right thing. Each case
          runs several times, because a tool that works four times in five is not a tool that works.
        </p>
      </header>

      <section className="flex flex-wrap items-center gap-3 rounded border border-slate-800 bg-slate-900/40 p-4">
        <button
          type="button"
          disabled={busy || start.isPending || chosen.length === 0}
          onClick={() => start.mutate({
            repeats,
            ...(selection.everything ? {} : { only: chosen }),
            ...(modelId ? { modelId, modelLabel: chosenModel?.name ?? modelId } : {}),
          })}
          className="rounded bg-sky-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? 'Running…' : `Run ${chosen.length} case${chosen.length === 1 ? '' : 's'}`}
        </button>

        <label className="flex items-center gap-2 text-sm text-slate-400">
          Model
          <select
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
            className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-100"
          >
            <option value="">Account default</option>
            {(models.data ?? []).map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
                {entry.model ? ` · ${entry.model}` : ''}
                {entry.sourceLabel ? ` (${entry.sourceLabel})` : ''}
              </option>
            ))}
          </select>
        </label>

        {models.data?.length === 0 && (
          <span className="text-sm text-amber-400">
            No models are set up yet — deploy one or add an endpoint first.
          </span>
        )}

        <label className="flex items-center gap-2 text-sm text-slate-400">
          Repeats
          <input
            type="number"
            min={1}
            max={25}
            value={repeats}
            onChange={(event) => setRepeats(Number(event.target.value))}
            className="w-16 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-100"
          />
        </label>

        <div className="flex gap-2 text-sm">
          <button type="button" onClick={selection.all} className="text-sky-400 hover:underline">
            All
          </button>
          <button type="button" onClick={selection.none} className="text-slate-500 hover:underline">
            None
          </button>
        </div>

        {busy && runId && (
          <button
            type="button"
            onClick={() => cancel.mutate(runId)}
            className="ml-auto rounded border border-slate-700 px-3 py-1.5 text-sm text-slate-300"
          >
            Stop
          </button>
        )}

        {run.data && (
          <span className="ml-auto text-sm text-slate-400">
            {run.data.modelLabel ? `${run.data.modelLabel} · ` : ''}
            {run.data.finished}/{run.data.total} cases
            {run.data.reliability && (
              <>
                {' · '}
                <span className="text-emerald-400">{run.data.reliability.always} solid</span>
                {' · '}
                <span className="text-amber-400">{run.data.reliability.flaky} flaky</span>
                {' · '}
                <span className="text-rose-400">{run.data.reliability.never} broken</span>
              </>
            )}
          </span>
        )}
      </section>

      {run.data?.error && (
        <p className="rounded border border-rose-900 bg-rose-950/40 p-3 text-sm text-rose-300">
          {run.data.error}
        </p>
      )}

      {cases.data && cases.data.coverage.length > 0 && (
        <details className="rounded border border-amber-900/60 bg-amber-950/20 p-4">
          <summary className="cursor-pointer text-sm text-amber-300">
            {cases.data.coverage.length} things nothing checks yet
          </summary>
          <ul className="mt-2 space-y-1">
            {cases.data.coverage.map((gap) => (
              <li key={`${gap.case}-${gap.message}`} className="text-sm text-amber-200/80">
                <span className="font-mono text-xs">{gap.case}</span> {gap.message}
              </li>
            ))}
          </ul>
        </details>
      )}

      {cases.isLoading && <p className="text-sm text-slate-500">Loading cases…</p>}
      {cases.isError && <p className="text-sm text-rose-400">Could not load the cases.</p>}

      {cases.data && (
        <CaseList
          cases={cases.data.cases}
          outcomes={run.data?.outcomes ?? []}
          {...(run.data?.running ? { running: run.data.running } : {})}
          isChosen={selection.isChosen}
          onToggle={selection.toggle}
        />
      )}
    </div>
  )
}
