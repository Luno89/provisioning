import { useState } from 'react'
import { errorMessage } from '../../../api/client'
import { dangerPanel, quietButton, useInvites, useMintInvite } from '../shared'
import type { Invite } from '../types'

const day = (at: string) => new Date(at).toLocaleDateString()

function standing(invite: Invite): { said: string; tag: string; tone: string } {
  if (invite.usedBy) return { said: `Used ${day(invite.usedAt ?? invite.createdAt)}`, tag: 'Used', tone: 'bg-slate-500/10 text-slate-400' }
  if (invite.expired) return { said: `Expired ${day(invite.expiresAt ?? invite.createdAt)}`, tag: 'Expired', tone: 'bg-amber-500/10 text-amber-400' }
  return { said: `Made ${day(invite.createdAt)}${invite.expiresAt ? `, works until ${day(invite.expiresAt)}` : ''}`, tag: 'Unused', tone: 'bg-green-500/10 text-green-500' }
}

export function Invites() {
  const invites = useInvites()
  const mint = useMintInvite()
  const [copied, setCopied] = useState(false)
  const list = invites.data ?? []
  const made = mint.data?.code
  const copy = async () => {
    if (!made) return
    await navigator.clipboard.writeText(made)
    setCopied(true)
  }
  return (
    <div className={dangerPanel}>
      <div className="flex items-center justify-between mb-1">
        <h4 className="text-lg font-bold text-white">Invites</h4>
        <button
          type="button"
          onClick={() => { setCopied(false); mint.mutate() }}
          disabled={mint.isPending}
          className="text-xs font-bold px-3 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 transition-colors cursor-pointer disabled:opacity-50"
        >
          {mint.isPending ? 'Generating...' : 'Generate invite'}
        </button>
      </div>
      <p className="text-xs text-slate-400 mb-4">Koala is invite-only. An invite works once, for two weeks; its code is shown only when it is made.</p>
      {invites.isError && <div role="alert" className="text-sm text-red-300">{errorMessage(invites.error)}</div>}
      {mint.isError && <div role="alert" className="text-sm text-red-300">{errorMessage(mint.error)}</div>}
      {made && (
        <div className="mb-4 p-4 rounded-2xl border border-blue-500/30 bg-blue-500/5" data-testid="new-invite">
          <div className="text-xs text-slate-300 mb-2">Send this code now. It will not be shown again.</div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-mono font-bold text-white break-all">{made}</span>
            <button type="button" className={quietButton} onClick={() => { void copy() }}>{copied ? 'Copied' : 'Copy'}</button>
          </div>
        </div>
      )}
      <div className="space-y-2">
        {invites.isSuccess && list.length === 0 && <div className="text-sm text-slate-500 italic">No invites generated yet.</div>}
        {[...list].reverse().map((invite) => {
          const { said, tag, tone } = standing(invite)
          return (
            <div key={invite.id} className="flex items-center justify-between bg-slate-900/40 p-4 rounded-2xl border border-white/5">
              <div className="text-xs text-slate-400">{said}</div>
              <span className={`text-[10px] font-bold px-3 py-1 rounded-full uppercase ${tone}`}>{tag}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
