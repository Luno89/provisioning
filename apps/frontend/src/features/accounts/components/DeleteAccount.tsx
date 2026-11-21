import { useState } from 'react'
import { errorMessage } from '../../../api/client'
import { useCan, useShellStore } from '../../platform'
import { dangerPanel, quietButton, refusalBlockers, useAccountRemovalPlace, useRemovalPreview, useRemoveMyAccount } from '../shared'
import { MyRemovalConfirm, RemovalBlockers } from './RemovalConfirm'
import { safeHref } from '../../../shared/lib/safe-href'

function RemovedOnRoot() {
  const place = useAccountRemovalPlace(true)
  return (
    <div className={dangerPanel} data-testid="delete-account">
      <h4 className="text-lg font-bold text-white mb-1">Delete account</h4>
      <p className="text-xs text-slate-400 mb-3">
        Your account is kept by Koala, where you sign in, and this instance is part of it. Deleting it there removes the account and lets go of this instance; you are told exactly what goes before anything does.
      </p>
      {place.isError && <div className="text-sm text-red-300">{errorMessage(place.error)}</div>}
      {place.data && <a href={safeHref(place.data)} className={`${quietButton} inline-block`}>Delete my account on Koala…</a>}
    </div>
  )
}

export function DeleteAccount() {
  return useCan()('manage-own-account') ? <DeleteHere /> : <RemovedOnRoot />
}

function DeleteHere() {
  const [open, setOpen] = useState(false)
  const setUser = useShellStore((s) => s.setUser)
  const pushNotification = useShellStore((s) => s.pushNotification)
  const preview = useRemovalPreview(open)
  const remove = useRemoveMyAccount(() => {
    pushNotification({ type: 'info', message: 'Your account is being removed, with everything in it.' })
    setUser(null)
  })

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
          {blockers.length > 0 && <RemovalBlockers blockers={blockers} />}
          {preview.data && blockers.length === 0 && (
            <>
              {preview.data.deletedProjects ? <p className="text-sm text-amber-300">This also deletes for good the {preview.data.deletedProjects} projects in Deleted projects.</p> : null}
              <MyRemovalConfirm email={preview.data.email} remove={remove} keep={<button type="button" className={quietButton} onClick={() => setOpen(false)}>Keep it</button>} />
            </>
          )}
        </div>
      )}
    </div>
  )
}
