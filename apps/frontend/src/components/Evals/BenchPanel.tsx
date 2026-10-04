import { useState } from 'react'
import type { BenchSettings, Level2Run, Scenario } from '../../api/evals'
import { errorMessage } from '../../api/client'
import { fieldClass, panelClass, quietButton, triggerLabel, useBench, useSaveBench } from './shared'

const HISTORY = 12

function Settings({ settings }: { settings: BenchSettings }) {
  const [draft, setDraft] = useState(settings)
  const save = useSaveBench()
  const changed = JSON.stringify(draft) !== JSON.stringify(settings)

  return (
    <div className="flex flex-wrap items-center gap-3 text-sm text-slate-400">
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />
        Run the bench on its own
      </label>
      <label className="flex items-center gap-2">
        after
        <input
          aria-label="Idle minutes before the bench runs"
          type="number" min={1} value={draft.idleMinutes}
          onChange={(event) => setDraft({ ...draft, idleMinutes: Number(event.target.value) })}
          className={`w-16 ${fieldClass}`}
        />
        idle minutes,
      </label>
      <label className="flex items-center gap-2">
        everything every
        <input
          aria-label="Hours between full bench runs"
          type="number" min={1} value={draft.fullEveryHours}
          onChange={(event) => setDraft({ ...draft, fullEveryHours: Number(event.target.value) })}
          className={`w-16 ${fieldClass}`}
        />
        hours, and a changed agent's scenarios at the next idle moment
      </label>
      <button type="button" disabled={!changed || save.isPending} onClick={() => save.mutate(draft)} className={quietButton}>Save</button>
      {save.error && <span className="text-rose-300">{errorMessage(save.error)}</span>}
    </div>
  )
}

export default function BenchPanel({ scenarios, runs }: { scenarios: Scenario[]; runs: Level2Run[] }) {
  const bench = useBench()
  const recent = runs.filter((run) => run.state === 'done').slice(0, HISTORY)

  return (
    <section className={`flex flex-col gap-3 ${panelClass}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Bench</h3>
        {bench.data?.state.lastFullAt && (
          <span className="text-xs text-slate-500">everything last ran {new Date(bench.data.state.lastFullAt).toLocaleString()}</span>
        )}
      </div>
      {bench.data && <Settings key={JSON.stringify(bench.data.settings)} settings={bench.data.settings} />}
      {bench.error && <p className="text-xs text-rose-300">{errorMessage(bench.error)}</p>}

      {recent.length > 0 && (
        <div className="overflow-x-auto">
          <table className="text-xs">
            <thead>
              <tr>
                <th className="pr-3 text-left font-normal text-slate-500">Scenario</th>
                {recent.map((run) => (
                  <th key={run.id} title={`${new Date(run.startedAt).toLocaleString()} · ${triggerLabel(run.trigger)}`} className="px-1 font-normal text-slate-500">
                    {new Date(run.startedAt).toLocaleDateString([], { month: 'numeric', day: 'numeric' })}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {scenarios.map((scenario) => (
                <tr key={scenario.id}>
                  <td className="pr-3 text-slate-300">{scenario.name}</td>
                  {recent.map((run) => {
                    const result = run.results.find((entry) => entry.scenarioId === scenario.id)
                    const regressed = (run.regressions ?? []).includes(scenario.id)
                    const mark = !result ? '·' : result.passed ? '✓' : '✗'
                    const label = !result ? 'not run' : result.passed ? 'passed' : regressed ? 'regressed' : 'failed'
                    return (
                      <td key={run.id} aria-label={`${scenario.name}, ${new Date(run.startedAt).toLocaleString()}: ${label}`} className={`px-1 text-center ${regressed ? 'font-bold text-rose-400' : result?.passed ? 'text-emerald-400' : result ? 'text-rose-300' : 'text-slate-600'}`}>
                        {mark}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
