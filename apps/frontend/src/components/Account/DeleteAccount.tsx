import { useState } from 'react'
import { errorMessage } from '../../api/client'
import { useShellStore } from '../../features/platform'
import { confirmMatches, dangerButton, dangerPanel, emailField, quietButton, refusalBlockers, useAccountRemovalPlace, useRemovalPreview, useRemoveMyAccount } from './shared'

function RemovedOnRoot() {
  const place = useAccountRemovalPlace(true)
  return (
    <div className={dangerPanel} data-testid="delete-account">
      <h4 className="text-lg font-bold text-white mb-1">Delete account</h4>
      <p className="text-xs text-slate-400 mb-3">
        Your account is kept by Koala, where you sign in, and this instance is part of it. Deleting it there removes the account and lets go of this instance; you are told exactly what goes before anything does.
      </p>
      {place.isError && <div className="text-sm text-red-300">{errorMessage(place.error)}</div>}
      {place.data && <a href={place.data} className={`${quietButton} inline-block`}>Delete my account on Koala…</a>}
    </div>
  )
}

export function DeleteAccount() {
  const holdsAccounts = useShellStore((s) => s.user?.holdsAccounts !== false)
  return holdsAccounts ? <DeleteHere /> : <RemovedOnRoot />
}

function DeleteHere() {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const setUser = useShellStore((s) => s.setUser)
  const pushNotification = useShellStore((s) => s.pushNotification)
  const preview = useRemovalPreview(open)
  const remove = useRemoveMyAccount(() => {
    pushNotification({ type: 'info', message: 'Your account is being removed, with everything in it.' })
    setUser(null)
  })

  const email = preview.data?.email ?? ''
  const blockers = preview.data?.blockers.length ? preview.data.blockers : refusalBlockers(remove.error)

  return (
    <div className={dangerPanel}>
      <div className="flex items-center justify-between mb-1">
        <h4 className="text-lg font-bold text-white">Delete account</h4>
        {!open && <button type="button" className={quietButton} onClick={() => setOpen(true)}>Delete account…</button>}
      </div>
      <p className="text-xs text-slate-400">
        Removes your conversations, trees, memories, runs, repositories, workspaces and machines on the mesh. It cannot be undone.
      </p>
      {open && (
        <div className="mt-4 space-y-3" data-testid="delete-account">
          {preview.isLoading && <div className="text-sm text-slate-500">Checking what is still running…</div>}
          {blockers.length > 0 && (
            <ul className="text-sm text-amber-300 list-disc pl-5 space-y-1">
              {blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
            </ul>
          )}
          {preview.data && blockers.length === 0 && (
            <>
              <label className="block text-xs text-slate-400">
                Type <span className="font-mono text-slate-200">{email}</span> to confirm
                <input className={`${emailField} mt-1`} value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" />
              </label>
              {remove.isError && blockers.length === 0 && <div className="text-sm text-red-300">{errorMessage(remove.error)}</div>}
              <div className="flex gap-2">
                <button type="button" className={dangerButton} disabled={!confirmMatches(typed, email) || remove.isPending} onClick={() => remove.mutate(typed)}>
                  {remove.isPending ? 'Removing…' : 'Delete my account'}
                </button>
                <button type="button" className={quietButton} onClick={() => { setOpen(false); setTyped('') }}>Keep it</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
