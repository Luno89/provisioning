import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { errorMessage } from '../../../api/client'
import { yoursGoes } from '../lib/person-instance'
import { confirmMatches, dangerButton, emailField, quietButton, refusalBlockers, useRemovalPreview, useRemoveMyAccount } from '../shared'

export interface RemoveAccountPageProps {
  onRemoved: () => void
}

export default function RemoveAccountPage({ onRemoved }: RemoveAccountPageProps) {
  const [typed, setTyped] = useState('')
  const [removed, setRemoved] = useState(false)
  const preview = useRemovalPreview(true)
  const remove = useRemoveMyAccount(() => setRemoved(true))

  const email = preview.data?.email ?? ''
  const blockers = preview.data?.blockers.length ? preview.data.blockers : refusalBlockers(remove.error)

  return (
    <div className="min-h-screen bg-[#0d0f14] text-slate-100 font-sans flex items-center justify-center p-6">
      <div className="w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-900/60 p-8 space-y-5" data-testid="remove-account-page">
        <h1 className="text-xl font-bold">Delete your Koala account</h1>
        {removed ? (
          <>
            <p className="text-sm text-slate-300">Your account is being removed, and you have been signed out everywhere.</p>
            <button type="button" className={quietButton} onClick={onRemoved}>Done</button>
          </>
        ) : (
          <>
            {preview.isLoading && <div className="flex items-center gap-2 text-sm text-slate-400"><Loader2 size={14} className="animate-spin" /> Checking what goes with it…</div>}
            {preview.isError && <div role="alert" className="text-sm text-red-300">{errorMessage(preview.error)}</div>}
            {preview.data && (
              <>
                <ul className="text-sm text-slate-300 list-disc pl-5 space-y-2">
                  <li>Your account, {email}, and your sign-in. Signing in again would start you afresh.</li>
                  {yoursGoes(preview.data.instance).map((line) => <li key={line}>{line}</li>)}
                </ul>
                <p className="text-xs text-slate-500">It cannot be undone.</p>
                {blockers.length > 0 ? (
                  <ul className="text-sm text-amber-300 list-disc pl-5 space-y-1">
                    {blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
                  </ul>
                ) : (
                  <>
                    <label className="block text-xs text-slate-400">
                      Type <span className="font-mono text-slate-200">{email}</span> to confirm
                      <input className={`${emailField} mt-1`} value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" />
                    </label>
                    {remove.isError && <div role="alert" className="text-sm text-red-300">{errorMessage(remove.error)}</div>}
                    <div className="flex gap-2">
                      <button type="button" className={dangerButton} disabled={!confirmMatches(typed, email) || remove.isPending} onClick={() => remove.mutate(typed)}>
                        {remove.isPending ? 'Removing…' : 'Delete my account'}
                      </button>
                      <a href="#/" className={quietButton}>Keep it</a>
                    </div>
                  </>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
