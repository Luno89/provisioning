import { useState } from 'react'
import { errorMessage } from '../../api/client'
import type { PersonEntry } from '../../types/account'
import { confirmMatches, dangerButton, dangerPanel, emailField, quietButton, refusalBlockers, removalText, usePeople, usePersonRemoval, useRemovePerson } from './shared'

function RemovePerson({ person, onClose }: { person: PersonEntry; onClose: () => void }) {
  const [typed, setTyped] = useState('')
  const preview = usePersonRemoval(person.id, true)
  const remove = useRemovePerson()
  const blockers = preview.data?.blockers.length ? preview.data.blockers : refusalBlockers(remove.error)

  return (
    <div className="mt-3 space-y-3" data-testid={`remove-${person.id}`}>
      {blockers.length > 0 && (
        <ul className="text-sm text-amber-300 list-disc pl-5 space-y-1">
          {blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
        </ul>
      )}
      {preview.data && blockers.length === 0 && (
        <>
          <label className="block text-xs text-slate-400">
            Type <span className="font-mono text-slate-200">{person.email}</span> to remove this account and everything in it
            <input className={`${emailField} mt-1`} value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" />
          </label>
          {remove.isError && <div className="text-sm text-red-300">{errorMessage(remove.error)}</div>}
          <div className="flex gap-2">
            <button type="button" className={dangerButton} disabled={!confirmMatches(typed, person.email) || remove.isPending} onClick={() => remove.mutate({ id: person.id, confirm: typed }, { onSuccess: onClose })}>
              {remove.isPending ? 'Removing…' : 'Remove account'}
            </button>
            <button type="button" className={quietButton} onClick={onClose}>Keep it</button>
          </div>
        </>
      )}
    </div>
  )
}

export function People() {
  const people = usePeople()
  const [removing, setRemoving] = useState<string | null>(null)
  const retry = useRemovePerson()

  return (
    <div className={dangerPanel}>
      <h4 className="text-lg font-bold text-white mb-1">People</h4>
      <p className="text-xs text-slate-400 mb-4">Everyone with an account here. Removing an account deletes everything it owns.</p>
      {people.isError && <div className="text-sm text-red-300">{errorMessage(people.error)}</div>}
      <div className="space-y-2">
        {(people.data ?? []).map((person) => (
          <div key={person.id} className="bg-slate-900/40 p-4 rounded-2xl border border-white/5">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-bold text-white truncate">{person.email}{person.isAdmin && <span className="ml-2 text-[10px] uppercase text-blue-300">admin</span>}</div>
                <div className="text-xs text-slate-400 mt-0.5">
                  {person.removal ? removalText(person.removal.state) : `Joined ${new Date(person.createdAt).toLocaleDateString()}`}
                </div>
              </div>
              {person.removal?.state.state === 'failed' && (
                <button type="button" className={dangerButton} disabled={retry.isPending} onClick={() => retry.mutate({ id: person.id, confirm: person.email })}>Try again</button>
              )}
              {!person.removal && removing !== person.id && (
                <button type="button" className={quietButton} onClick={() => setRemoving(person.id)}>Remove…</button>
              )}
            </div>
            {removing === person.id && !person.removal && <RemovePerson person={person} onClose={() => setRemoving(null)} />}
          </div>
        ))}
      </div>
    </div>
  )
}
