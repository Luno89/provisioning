import type { Practice } from '../../api/evals'
import { errorMessage } from '../../api/client'
import { panelClass, primaryButton, quietButton, useDecidePractice, usePractices } from './shared'

const GROUPS: { status: NonNullable<Practice['status']>; title: string; says: string }[] = [
  { status: 'pending_review', title: 'Held for you', says: 'Something regressed when the bench tried these, so they wait for you.' },
  { status: 'trial', title: 'On trial', says: 'The bench tries these with the agent\'s scenarios at the next idle moment.' },
  { status: 'active', title: 'Live', says: 'These are in the agent\'s prompt now.' },
]

function trialResult(practice: Practice): string {
  const trial = practice.trial
  if (!trial) return ''
  if (trial.unchecked) return 'went live unchecked — the agent has no scenarios to try it against'
  const regressions = trial.regressions ?? []
  return regressions.length > 0
    ? `regressed ${regressions.join(', ')} in bench run ${trial.runId ?? ''}`
    : `nothing regressed across ${trial.scenarios?.length ?? 0} scenario${trial.scenarios?.length === 1 ? '' : 's'}`
}

export default function PracticesPanel({ agent }: { agent?: string | undefined } = {}) {
  const practices = usePractices()
  const { live, retire } = useDecidePractice()
  const all = (practices.data ?? []).filter((practice) => !agent || practice.agent === agent)
  const error = live.error ?? retire.error
  if (all.length === 0) return null

  return (
    <section className={`flex flex-col gap-3 ${panelClass}`}>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Practices</h3>
      <p className="text-xs text-slate-500">Lessons about how an agent should work, learned from its runs. Each one is tried on the bench first and goes live only if nothing gets worse.</p>
      {error && <p className="text-xs text-rose-300">{errorMessage(error)}</p>}
      {GROUPS.map((group) => {
        const members = all.filter((practice) => (practice.status ?? 'active') === group.status)
        if (members.length === 0) return null
        return (
          <div key={group.status} className="flex flex-col gap-2">
            <h4 className="text-xs font-semibold text-slate-300">{group.title} ({members.length})</h4>
            <p className="text-[11px] text-slate-500">{group.says}</p>
            <ul className="flex flex-col gap-2">
              {members.map((practice) => (
                <li key={practice.id} className="rounded border border-[var(--bark-700)] p-3 text-sm">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-semibold text-slate-200">{practice.title}</span>
                    <span className="text-xs text-slate-500">for {practice.agent}</span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-xs text-slate-300">{practice.text}</p>
                  {practice.trial && <p className="mt-1 text-xs text-slate-400">Trial: {trialResult(practice)}</p>}
                  <div className="mt-2 flex gap-2">
                    {practice.status !== 'active' && (
                      <button type="button" disabled={live.isPending} onClick={() => live.mutate(practice.id)} className={primaryButton}>Make live</button>
                    )}
                    <button type="button" disabled={retire.isPending} onClick={() => retire.mutate(practice.id)} className={quietButton}>Retire</button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </section>
  )
}
