import { Loader2 } from 'lucide-react'
import { errorMessage } from '../../api/client'
import { ROLE_SAID, useAcceptInvitation, useInvitation } from './shared'

export default function JoinPage({ token, me, onJoined }: { token: string; me: string; onJoined: (projectId: string) => void }) {
  const invitation = useInvitation(token)
  const accept = useAcceptInvitation(token)

  if (invitation.isPending) return <p className="p-6 text-[12px] text-slate-500"><Loader2 size={12} className="inline animate-spin" /> Reading the invite…</p>
  if (invitation.isError) return <p className="p-6 text-[13px] text-red-300">{errorMessage(invitation.error)}</p>
  const { projectName, role, email, forYou } = invitation.data

  return (
    <div className="mx-auto max-w-lg space-y-3 p-6" data-testid="join-project">
      <h1 className="text-xl font-semibold text-slate-100">Join {projectName}</h1>
      <p className="text-[13px] text-slate-300">You are invited as {role === 'owner' ? 'an owner' : `a ${ROLE_SAID[role].title.toLowerCase()}`}: {ROLE_SAID[role].can}</p>
      {forYou ? (
        <button type="button" disabled={accept.isPending} onClick={() => accept.mutate(undefined, { onSuccess: (view) => onJoined(view.project.id) })} className="rounded bg-[var(--leaf-stem)] px-3 py-1.5 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-50">
          {accept.isPending ? 'Joining…' : `Join ${projectName}`}
        </button>
      ) : (
        <p className="text-[13px] text-amber-200">This invite is for {email}, and you are signed in as {me}. Sign in as {email} to take it.</p>
      )}
      {accept.isError && <p role="alert" className="text-[12px] text-red-300">{errorMessage(accept.error)}</p>}
    </div>
  )
}
