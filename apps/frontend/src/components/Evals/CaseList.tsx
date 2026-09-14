import { CATEGORY_LABEL } from './shared'
import type { CaseOutcome, EvalCaseSummary } from '../../api/evals'
import { standing } from '../../api/evals'

interface CaseListProps {
  cases: EvalCaseSummary[]
  outcomes: CaseOutcome[]
  running?: string | undefined
  isChosen: (name: string) => boolean
  onToggle: (name: string) => void
}

const MARK: Record<string, { text: string; className: string }> = {
  pass: { text: 'passed every time', className: 'text-emerald-400' },
  flaky: { text: 'flaky', className: 'text-amber-400' },
  fail: { text: 'failed every time', className: 'text-rose-400' },
}

export default function CaseList({ cases, outcomes, running, isChosen, onToggle }: CaseListProps) {
  const byName = new Map(outcomes.map((outcome) => [outcome.name, outcome]))

  return (
    <ul className="divide-y divide-slate-800">
      {cases.map((entry) => {
        const outcome = byName.get(entry.name)
        const mark = outcome ? MARK[standing(outcome)] : undefined
        const active = running === entry.name

        return (
          <li key={entry.name} className="py-3">
            <div className="flex items-start gap-3">
              <input
                type="checkbox"
                className="mt-1 accent-sky-500"
                checked={isChosen(entry.name)}
                onChange={() => onToggle(entry.name)}
                aria-label={`Include ${entry.name}`}
              />

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="font-mono text-sm text-slate-100">{entry.name}</span>
                  <span className="text-xs uppercase tracking-wide text-slate-500">
                    {CATEGORY_LABEL[entry.category] ?? entry.category}
                  </span>
                  <span className="font-mono text-xs text-slate-500">
                    {entry.expects ?? 'calls nothing'}
                  </span>
                  {active && <span className="text-xs text-sky-400">running…</span>}
                  {outcome && mark && (
                    <span className={`text-xs ${mark.className}`}>
                      {outcome.passed}/{outcome.attempts} · {mark.text}
                    </span>
                  )}
                </div>

                <p className="mt-1 whitespace-pre-wrap text-sm text-slate-400">{entry.say}</p>

                {outcome && outcome.complaints.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {[...new Set(outcome.complaints)].map((complaint) => (
                      <li key={complaint} className="font-mono text-xs text-rose-300">
                        {complaint}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
