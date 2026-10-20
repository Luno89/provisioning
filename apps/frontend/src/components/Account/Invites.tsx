import { errorMessage } from '../../api/client'
import { dangerPanel, useInvites, useMintInvite } from './shared'

export function Invites() {
  const invites = useInvites()
  const mint = useMintInvite()
  const list = invites.data ?? []
  return (
    <div className={dangerPanel}>
      <div className="flex items-center justify-between mb-1">
        <h4 className="text-lg font-bold text-white">Invites</h4>
        <button
          type="button"
          onClick={() => mint.mutate()}
          disabled={mint.isPending}
          className="text-xs font-bold px-3 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 transition-colors cursor-pointer disabled:opacity-50"
        >
          {mint.isPending ? 'Generating...' : 'Generate invite'}
        </button>
      </div>
      <p className="text-xs text-slate-400 mb-4">Koala is invite-only. Share an unused code with anyone you want to give an account.</p>
      {invites.isError && <div role="alert" className="text-sm text-red-300">{errorMessage(invites.error)}</div>}
      {mint.isError && <div role="alert" className="text-sm text-red-300">{errorMessage(mint.error)}</div>}
      <div className="space-y-2">
        {invites.isSuccess && list.length === 0 && <div className="text-sm text-slate-500 italic">No invites generated yet.</div>}
        {[...list].reverse().map((invite) => (
          <div key={invite.id} className="flex items-center justify-between bg-slate-900/40 p-4 rounded-2xl border border-white/5">
            <div>
              <div className="text-sm font-mono font-bold text-white">{invite.code}</div>
              <div className="text-xs text-slate-400 mt-0.5">
                {invite.usedBy ? `Used ${new Date(invite.usedAt ?? invite.createdAt).toLocaleDateString()}` : `Created ${new Date(invite.createdAt).toLocaleDateString()}`}
              </div>
            </div>
            <span className={`text-[10px] font-bold px-3 py-1 rounded-full uppercase ${invite.usedBy ? 'bg-slate-500/10 text-slate-400' : 'bg-green-500/10 text-green-500'}`}>
              {invite.usedBy ? 'Used' : 'Unused'}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
