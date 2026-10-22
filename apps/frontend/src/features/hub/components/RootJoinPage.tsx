import { useEffect } from 'react'
import { Loader2, Users } from 'lucide-react'
import { errorMessage } from '../../../api/client'
import type { SessionUser } from '../../platform'
import { Login } from '../../accounts'
import { rememberJoin, forgetJoin } from '../lib/pending-join'
import { ROLE_SAID, useRootInvitation } from '../shared'
import type { HubRole } from '../types'

export default function RootJoinPage({ code, project, user, onSignedIn, onContinue, onSignOut }: {
  code: string
  project: string
  user: SessionUser | null
  onSignedIn: (user: SessionUser) => void
  onContinue: (project: string) => void
  onSignOut: () => void
}) {
  const invitation = useRootInvitation(code)
  useEffect(() => { if (code && project) rememberJoin({ code, project }) }, [code, project])

  if (invitation.isPending) return <div className="flex min-h-screen items-center justify-center bg-[var(--bark-900)]"><Loader2 className="h-6 w-6 animate-spin text-slate-400" /></div>
  if (invitation.isError || !invitation.data.project) {
    return <div className="flex min-h-screen items-center justify-center bg-[var(--bark-900)] p-6 text-[13px] text-red-300">{invitation.isError ? errorMessage(invitation.error) : 'This is not an invite to a project.'}</div>
  }
  const { project: invited, email } = invitation.data
  const role = invited.role as HubRole
  const intro = (
    <div className="mx-auto mb-4 max-w-md space-y-1 text-center">
      <p className="flex items-center justify-center gap-2 text-lg font-semibold text-slate-100"><Users size={18} className="text-[var(--leaf)]" /> Join {invited.name}</p>
      <p className="text-[13px] text-slate-400">You are invited as {role === 'owner' ? 'an owner' : `a ${ROLE_SAID[role]?.title.toLowerCase() ?? role}`}{email ? `, as ${email}` : ''}.</p>
    </div>
  )

  if (!user) {
    return (
      <div data-testid="root-join" className="bg-[#0d0f14]">
        <div className="pt-8">{intro}</div>
        <Login onSuccess={onSignedIn} invite={invitation.data.used ? undefined : { code, ...(email ? { email } : {}) }} />
      </div>
    )
  }

  const wrongPerson = email && email.toLowerCase() !== user.email.toLowerCase()
  return (
    <div data-testid="root-join" className="flex min-h-screen items-center justify-center bg-[var(--bark-900)] p-6">
      <div className="w-full max-w-md space-y-3 rounded-2xl border border-[var(--bark-700)] bg-[var(--bark-800)] p-6 text-center">
        {intro}
        {wrongPerson ? (
          <>
            <p className="text-[13px] text-amber-200">This invite is for {email}, and you are signed in as {user.email}.</p>
            <button type="button" onClick={onSignOut} className="rounded-md border border-[var(--bark-600)] px-3 py-1.5 text-[13px] text-slate-200">Sign out to use {email}</button>
          </>
        ) : (
          <button type="button" onClick={() => { forgetJoin(); onContinue(project) }} className="rounded-md bg-[var(--leaf-stem)] px-3 py-1.5 text-[13px] font-medium text-white hover:brightness-110">Continue to {invited.name}</button>
        )}
      </div>
    </div>
  )
}
