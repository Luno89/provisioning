import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { errorMessage } from '../../../api/client'
import { yoursGoes } from '../lib/person-instance'
import { quietButton, refusalBlockers, useRemovalPreview, useRemoveMyAccount } from '../shared'
import { MyRemovalConfirm, RemovalBlockers } from './RemovalConfirm'
import { MyRemovalProgress } from './MyRemovalProgress'

export interface RemoveAccountPageProps {
  onRemoved: () => void
}

export default function RemoveAccountPage({ onRemoved }: RemoveAccountPageProps) {
  const [removed, setRemoved] = useState<string | null>(null)
  const preview = useRemovalPreview(true)
  const remove = useRemoveMyAccount((started) => setRemoved(started.progress))

  const email = preview.data?.email ?? ''
  const blockers = preview.data?.blockers.length ? preview.data.blockers : refusalBlockers(remove.error)

  return (
    <div className="min-h-screen bg-[#0d0f14] text-slate-100 font-sans flex items-center justify-center p-6">
      <div className="w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-900/60 p-8 space-y-5" data-testid="remove-account-page">
        <h1 className="text-xl font-bold">Delete your Koala account</h1>
        {removed ? (
          <>
            <p className="text-sm text-slate-300">Your account is being removed, and you have been signed out everywhere.</p>
            <MyRemovalProgress progress={removed} />
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
                {blockers.length > 0
                  ? <RemovalBlockers blockers={blockers} />
                  : <MyRemovalConfirm email={email} remove={remove} keep={<a href="#/" className={quietButton}>Keep it</a>} />}
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
