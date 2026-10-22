import { useState } from 'react'
import { Check, Copy, Loader2, Mail, UserMinus, Users } from 'lucide-react'
import { errorMessage } from '../../../api/client'
import { HUB_ROLES, type HubRole, type InviteSent } from '../types'
import { youAre } from '../lib/hub-chat'
import { ROLE_SAID, usePeopleChanges, useSharedProject } from '../shared'

const field = 'rounded border border-[var(--bark-600)] bg-[var(--bark-900)] px-2 py-1 text-[12px] text-slate-200'
const button = 'rounded bg-[var(--leaf-stem)] px-2.5 py-1 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-50'

function Sent({ sent }: { sent: InviteSent }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="space-y-1 rounded border border-[var(--bark-700)] p-2 text-[12px]" data-testid="invite-sent">
      <p className="text-slate-300">
        {sent.emailed ? <>An invite went to <span className="text-slate-100">{sent.email}</span> by email.</> : <>The invite for <span className="text-slate-100">{sent.email}</span> was not emailed ({sent.why}). Send them this link yourself:</>}
      </p>
      <div className="flex items-center gap-1.5">
        <input readOnly aria-label="The invite link" value={sent.link} onFocus={(event) => event.target.select()} className={`${field} min-w-0 flex-1 font-mono text-[11px]`} />
        <button type="button" aria-label="Copy the invite link" onClick={() => { void navigator.clipboard?.writeText(sent.link).then(() => setCopied(true), () => setCopied(false)) }} className="rounded p-1 text-slate-400 hover:bg-[var(--bark-700)] hover:text-slate-100">
          {copied ? <Check size={12} className="text-emerald-300" /> : <Copy size={12} />}
        </button>
      </div>
      <p className="text-[11px] text-slate-500">It works only for {sent.email}.</p>
    </div>
  )
}

export default function SharedProjectPage({ id, me, onLeft, embedded = false }: { id: string; me: string; onLeft?: (() => void) | undefined; embedded?: boolean }) {
  const view = useSharedProject(id)
  const { invite, takeBack, changeRole, remove, deleteProject } = usePeopleChanges(id)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<HubRole>('client')
  const [leaving, setLeaving] = useState(false)
  const [typed, setTyped] = useState('')

  if (view.isPending) return <p className="p-6 text-[12px] text-slate-500"><Loader2 size={12} className="inline animate-spin" /> Opening the project…</p>
  if (view.isError) return <p className="p-6 text-[12px] text-red-300">{errorMessage(view.error)}</p>
  const { project, can } = view.data
  const owner = can.includes('invite')
  const failure = invite.error ?? takeBack.error ?? changeRole.error ?? remove.error ?? deleteProject.error

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-6" data-testid="shared-project">
      {!embedded && (
        <header className="space-y-1">
          <h1 className="flex items-center gap-2 text-xl font-semibold text-slate-100"><Users size={18} className="text-[var(--leaf)]" /> {project.name}</h1>
          <p className="text-[12px] text-slate-400">{youAre(view.data.role)}</p>
        </header>
      )}

      {project.group && (
        <p className="text-[12px] text-slate-400" data-testid="shared-group">Its apps are addressed under the group <span className="font-mono text-slate-200">{project.group}</span>, as <span className="font-mono text-slate-200">&lt;app&gt;-{project.group}</span>.</p>
      )}

      <section className="space-y-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">People</h2>
        <ul className="divide-y divide-[var(--bark-800)] rounded-md border border-[var(--bark-700)]">
          {(view.data.members ?? []).map((member) => (
            <li key={member.personId} className="flex flex-wrap items-center gap-2 px-3 py-2 text-[12px]">
              <span className="min-w-0 flex-1 truncate text-slate-200">{member.email}{member.personId === me ? <span className="text-slate-500"> (you)</span> : null}</span>
              {owner ? (
                <select aria-label={`What ${member.email} may do`} value={member.role} disabled={changeRole.isPending} onChange={(event) => changeRole.mutate({ personId: member.personId, role: event.target.value as HubRole })} className={field}>
                  {HUB_ROLES.map((choice) => <option key={choice} value={choice}>{ROLE_SAID[choice].title}</option>)}
                </select>
              ) : <span className="text-slate-400">{ROLE_SAID[member.role].title}</span>}
              {owner && member.personId !== me && (
                <button type="button" aria-label={`Remove ${member.email}`} onClick={() => remove.mutate(member.personId)} className="rounded p-1 text-slate-500 hover:text-red-300"><UserMinus size={13} /></button>
              )}
            </li>
          ))}
        </ul>
      </section>

      {owner && (
        <section className="space-y-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Invite someone</h2>
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(event) => { event.preventDefault(); if (email.trim()) invite.mutate({ email: email.trim(), role }, { onSuccess: () => setEmail('') }) }}
          >
            <input aria-label="Their email address" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" className={`${field} min-w-0 flex-1`} />
            <select aria-label="What they may do" value={role} onChange={(event) => setRole(event.target.value as HubRole)} className={field}>
              {HUB_ROLES.map((choice) => <option key={choice} value={choice}>{ROLE_SAID[choice].title}</option>)}
            </select>
            <button type="submit" disabled={invite.isPending || !email.trim()} className={button}><Mail size={11} className="mr-1 inline" />{invite.isPending ? 'Inviting…' : 'Invite'}</button>
          </form>
          <p className="text-[11px] text-slate-500">{ROLE_SAID[role].can}</p>
          {invite.data && <Sent sent={invite.data} />}
          {(view.data.invites ?? []).length > 0 && (
            <ul className="space-y-1" data-testid="pending-invites">
              {(view.data.invites ?? []).map((pending) => (
                <li key={pending.email} className="flex items-center gap-2 text-[12px] text-slate-400">
                  <span className="flex-1">{pending.email} · {ROLE_SAID[pending.role].title} · invited, not joined yet</span>
                  <button type="button" onClick={() => takeBack.mutate(pending.email)} className="text-[11px] text-slate-500 underline hover:text-slate-200">Take back</button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {failure && <p role="alert" className="text-[12px] text-red-300">{errorMessage(failure)}</p>}

      <section className="border-t border-[var(--bark-800)] pt-3">
        {leaving
          ? (
            <div className="flex items-center gap-2 text-[12px]">
              <span className="text-slate-300">Leave {project.name}? You will need a new invite to come back.</span>
              <button type="button" onClick={() => remove.mutate(me, { onSuccess: () => onLeft?.() })} className="rounded bg-red-600 px-2 py-0.5 text-white hover:bg-red-500">Leave</button>
              <button type="button" onClick={() => setLeaving(false)} className="text-slate-400 underline">Stay</button>
            </div>
          )
          : <button type="button" onClick={() => setLeaving(true)} className="text-[12px] text-slate-500 underline hover:text-slate-300">Leave this project</button>}
      </section>

      {can.includes('change-settings') && (
        <section className="space-y-1.5 rounded-md border border-red-900/60 p-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-red-300">Delete this shared project</h2>
          <p className="text-[12px] text-slate-400">Everyone loses it, and invites not yet taken stop working. Type {project.name} to delete it.</p>
          <form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); deleteProject.mutate(typed, { onSuccess: () => onLeft?.() }) }}>
            <input aria-label="The project's name, to delete it" value={typed} onChange={(event) => setTyped(event.target.value)} className={`${field} min-w-0 flex-1`} />
            <button type="submit" disabled={typed !== project.name || deleteProject.isPending} className="rounded bg-red-600 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-red-500 disabled:opacity-40">{deleteProject.isPending ? 'Deleting…' : 'Delete'}</button>
          </form>
        </section>
      )}
    </div>
  )
}
