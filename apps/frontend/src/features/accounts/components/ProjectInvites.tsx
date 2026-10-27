import { useState } from 'react'
import { errorMessage } from '../../../api/client'
import { dangerPanel, emailField, quietButton, useProjectInviteLimits, useSetOwnInviteAccounts, useSetProjectInviteLimits } from '../shared'
import type { ProjectInvitePerson } from '../types'

const whole = (text: string): number | undefined => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : undefined)

function Defaults({ accounts, perHour }: { accounts: number; perHour: number }) {
  const save = useSetProjectInviteLimits()
  const [typedAccounts, setTypedAccounts] = useState(String(accounts))
  const [typedHour, setTypedHour] = useState(String(perHour))
  const nextAccounts = whole(typedAccounts)
  const nextHour = whole(typedHour)
  const changed = nextAccounts !== accounts || nextHour !== perHour
  return (
    <form
      className="flex flex-wrap items-end gap-3 mb-4"
      onSubmit={(event) => { event.preventDefault(); if (nextAccounts !== undefined && nextHour !== undefined) save.mutate({ accounts: nextAccounts, perHour: nextHour }) }}
    >
      <label className="text-xs text-slate-400 space-y-1">
        <span className="block">New people each person may bring</span>
        <input aria-label="New people each person may bring" inputMode="numeric" value={typedAccounts} onChange={(event) => setTypedAccounts(event.target.value)} className={`${emailField} w-28`} />
      </label>
      <label className="text-xs text-slate-400 space-y-1">
        <span className="block">Invites a person may send an hour</span>
        <input aria-label="Invites a person may send an hour" inputMode="numeric" value={typedHour} onChange={(event) => setTypedHour(event.target.value)} className={`${emailField} w-28`} />
      </label>
      <button type="submit" disabled={!changed || nextAccounts === undefined || nextHour === undefined || nextHour < 1 || save.isPending} className={`${quietButton} disabled:opacity-40`}>
        {save.isPending ? 'Saving…' : 'Save'}
      </button>
      {save.isError && <div role="alert" className="basis-full text-sm text-red-300">{errorMessage(save.error)}</div>}
    </form>
  )
}

function Person({ person, accounts }: { person: ProjectInvitePerson; accounts: number }) {
  const save = useSetOwnInviteAccounts()
  const [typed, setTyped] = useState(person.own === undefined ? '' : String(person.own))
  const next = whole(typed)
  const allowed = person.own ?? accounts
  return (
    <div className="flex flex-wrap items-center gap-3 bg-slate-900/40 p-3 rounded-2xl border border-white/5" data-testid="project-invite-person">
      <span className="min-w-0 flex-1 truncate text-sm text-slate-200">{person.email}</span>
      <span className={`text-xs ${person.made >= allowed ? 'text-amber-300' : 'text-slate-400'}`}>{person.made} of {allowed}{person.own === undefined ? ' (the default)' : ''}</span>
      <input aria-label={`New people ${person.email} may bring`} inputMode="numeric" placeholder={String(accounts)} value={typed} onChange={(event) => setTyped(event.target.value)} className={`${emailField} w-20`} />
      <button type="button" disabled={next === undefined || next === person.own || save.isPending} onClick={() => { if (next !== undefined) save.mutate({ id: person.id, accounts: next }) }} className={`${quietButton} disabled:opacity-40`}>Set</button>
      {person.own !== undefined && (
        <button type="button" disabled={save.isPending} onClick={() => { setTyped(''); save.mutate({ id: person.id, accounts: null }) }} className="text-xs text-slate-400 underline hover:text-slate-200">Use the default</button>
      )}
      {save.isError && <div role="alert" className="basis-full text-sm text-red-300">{errorMessage(save.error)}</div>}
    </div>
  )
}

export function ProjectInvites() {
  const limits = useProjectInviteLimits()
  return (
    <div className={dangerPanel} data-testid="project-invites">
      <h4 className="text-lg font-bold text-white mb-1">Project invites</h4>
      <p className="text-xs text-slate-400 mb-4">Inviting someone to a shared project makes an invite to Koala too. These say how many new people one person&apos;s invites may bring, and how many invites they may send an hour; inviting someone who already has an account brings no one new. Admins are not limited.</p>
      {limits.isError && <div role="alert" className="text-sm text-red-300">{errorMessage(limits.error)}</div>}
      {limits.data && (
        <>
          <Defaults key={`${limits.data.accounts}-${limits.data.perHour}`} accounts={limits.data.accounts} perHour={limits.data.perHour} />
          <div className="space-y-2">
            {limits.data.people.length === 0 && <div className="text-sm text-slate-500 italic">Nobody but admins has an account yet.</div>}
            {limits.data.people.map((person) => <Person key={`${person.id}-${person.own ?? ''}`} person={person} accounts={limits.data.accounts} />)}
          </div>
        </>
      )}
    </div>
  )
}
