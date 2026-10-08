import type { CoverageGap } from '../../api/evals'
import { toolReliability } from '../../lib/check-history'
import { panelClass, useCoverage, useLevel2Runs, useScenarios } from './shared'

type CoverageScope = { tool: string } | { agent: string; heldTools: readonly string[] }

const belongs = (gap: CoverageGap, scope: CoverageScope): boolean => {
  if ('tool' in scope) return gap.kind !== 'no-restraint' && gap.tool === scope.tool
  return gap.kind === 'no-restraint' ? gap.agent === scope.agent : scope.heldTools.includes(gap.tool)
}

export default function Coverage({ scope }: { scope: CoverageScope }) {
  const coverage = useCoverage()
  const scenarios = useScenarios()
  const runs = useLevel2Runs()
  const gaps = (coverage.data ?? []).filter((gap) => belongs(gap, scope))
  const turnChecks = (scenarios.data ?? []).filter((scenario) => scenario.turn && ('tool' in scope ? scenario.expect.chooses?.tool === scope.tool : scenario.agent === scope.agent))
  const reliability = toolReliability(runs.data ?? [], turnChecks.map((scenario) => scenario.id))

  return (
    <div className="space-y-4">
      <section className={panelClass}>
        <h2 className="mb-2 text-sm font-semibold text-slate-300">
          {'tool' in scope ? 'How reliably a model chooses it' : 'How reliably it chooses its tools'}
        </h2>
        {turnChecks.length === 0
          ? <p className="text-sm text-slate-500">No turn check {'tool' in scope ? 'expects a model to choose it' : 'is of this agent'} yet.</p>
          : reliability
            ? (
              <p className="text-sm text-slate-300">
                <span className="font-mono">{reliability.passed}/{reliability.attempts}</span> attempts right, over the last run of {reliability.checks} of its {turnChecks.length} turn check{turnChecks.length === 1 ? '' : 's'}.
              </p>
            )
            : <p className="text-sm text-slate-500">Its {turnChecks.length} turn check{turnChecks.length === 1 ? ' has' : 's have'} not run yet.</p>}
      </section>

      <section className={panelClass}>
        <h2 className="mb-2 text-sm font-semibold text-slate-300">What no check covers yet</h2>
        {coverage.isPending && <p className="text-sm text-slate-500">Working out what is covered…</p>}
        {coverage.isError && <p className="text-sm text-rose-400">Coverage could not be worked out.</p>}
        {coverage.data && gaps.length === 0 && <p className="text-sm text-slate-500">Nothing — every tool it touches is checked, and every failure it declares is provoked.</p>}
        {gaps.length > 0 && (
          <ul className="space-y-1">
            {gaps.map((gap) => (
              <li key={gap.message} className={`text-xs ${gap.kind === 'uncovered' ? 'text-amber-300' : 'text-slate-400'}`}>{gap.message}</li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
