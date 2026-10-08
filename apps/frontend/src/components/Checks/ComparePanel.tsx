import { useState } from 'react'
import { runLabel } from '../../lib/check-history'
import { scenarioSubjects, within, type Scope } from '../../lib/check-subjects'
import { panelClass, useComparison, useLevel2Runs, useScenarios } from './shared'

const percent = (change: number | undefined) =>
  change === undefined ? '—' : `${change > 0 ? '+' : ''}${Math.round(change * 100)}%`

const tone = (change: number | undefined) =>
  change === undefined ? 'text-slate-500' : change > 0 ? 'text-emerald-400' : change < 0 ? 'text-rose-400' : 'text-slate-400'

const rate = (value: { passed: number; attempts: number } | undefined) =>
  value ? `${value.passed}/${value.attempts}` : 'not run'

export default function ComparePanel({ scope }: { scope?: Scope | undefined } = {}) {
  const runs = useLevel2Runs()
  const scenarios = useScenarios()
  const inScope = new Set((scenarios.data ?? []).filter((scenario) => !scope || within(scenarioSubjects(scenario), scope)).map((scenario) => scenario.id))
  const finished = (runs.data ?? []).filter((run) => run.state !== 'running' && run.results.some((result) => inScope.has(result.scenarioId)))
  const [afterId, setAfterId] = useState<string>()
  const [beforeId, setBeforeId] = useState<string>()

  const after = afterId ?? finished[0]?.id
  const before = beforeId ?? finished[1]?.id
  const comparison = useComparison(before, after)

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-slate-400">
        Put two finished check runs side by side: what was set up differently, and which checks and
        tools moved, counting every repeat.
      </p>

      <section className={`flex flex-wrap items-end gap-4 ${panelClass}`}>
        <label className="flex flex-col gap-1 text-xs text-slate-400">
          Before
          <select
            value={before ?? ''}
            onChange={(event) => setBeforeId(event.target.value)}
            className="w-80 rounded border border-[var(--bark-600)] bg-[var(--bark-900)] px-2 py-1 text-xs text-slate-200"
          >
            {finished.map((run) => <option key={run.id} value={run.id}>{runLabel(run)}</option>)}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-slate-400">
          After
          <select
            value={after ?? ''}
            onChange={(event) => setAfterId(event.target.value)}
            className="w-80 rounded border border-[var(--bark-600)] bg-[var(--bark-900)] px-2 py-1 text-xs text-slate-200"
          >
            {finished.map((run) => <option key={run.id} value={run.id}>{runLabel(run)}</option>)}
          </select>
        </label>
      </section>

      {finished.length < 2 && (
        <p className="text-sm text-slate-500">There have to be two finished runs of these checks before anything can be compared.</p>
      )}

      {comparison.isPending && finished.length >= 2 && <p className="text-sm text-slate-500">Working out what changed…</p>}
      {comparison.isError && <p className="text-sm text-rose-400">Those two runs could not be compared.</p>}

      {comparison.data && (
        <>
          <section className={panelClass}>
            <h2 className="mb-2 text-sm font-semibold text-slate-300">What was different about the runs</h2>
            {comparison.data.differences.length === 0
              ? <p className="text-sm text-slate-500">Nothing about how they were set up changed.</p>
              : (
                <ul className="space-y-1">
                  {comparison.data.differences.map((difference) => (
                    <li key={difference.what} className="flex flex-wrap gap-2 text-xs">
                      <span className="w-40 shrink-0 text-slate-400">{difference.what}</span>
                      <span className="font-mono text-slate-500">{difference.before}</span>
                      <span className="text-slate-600">→</span>
                      <span className="font-mono text-slate-200">{difference.after}</span>
                    </li>
                  ))}
                </ul>
              )}
          </section>

          <section className={panelClass}>
            <h2 className="mb-2 text-sm font-semibold text-slate-300">Checks that moved</h2>
            <ul className="space-y-1">
              {comparison.data.checks.filter((entry) => inScope.has(entry.id)).map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-baseline gap-2 text-xs">
                  <span className={`w-16 shrink-0 font-mono ${tone(entry.change)}`}>{percent(entry.change)}</span>
                  <span className="text-slate-200">{entry.name}</span>
                  <span className="text-slate-500">{rate(entry.before)} → {rate(entry.after)}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className={panelClass}>
            <h2 className="mb-2 text-sm font-semibold text-slate-300">How reliably each tool was chosen, over the turn checks both runs share</h2>
            {comparison.data.tools.length === 0
              ? <p className="text-sm text-slate-500">These two runs have no turn checks in common.</p>
              : (
                <ul className="space-y-1">
                  {comparison.data.tools.map((entry) => (
                    <li key={entry.tool} className="flex flex-wrap items-baseline gap-2 text-xs">
                      <span className={`w-16 shrink-0 font-mono ${tone(entry.change)}`}>{percent(entry.change)}</span>
                      <span className="font-mono text-slate-200">{entry.tool}</span>
                      <span className="text-slate-500">{rate(entry.before)} → {rate(entry.after)}</span>
                    </li>
                  ))}
                </ul>
              )}
          </section>
        </>
      )}
    </div>
  )
}
