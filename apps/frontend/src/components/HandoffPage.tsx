import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { exchangeHandoff, signInElsewhere, type SessionUser } from '../api/auth'
import { errorMessage } from '../api/client'

export interface HandoffPageProps {
  token: string | null
  onSignedIn: (user: SessionUser) => void
}

export default function HandoffPage({ token, onSignedIn }: HandoffPageProps) {
  const [failure, setFailure] = useState<string | null>(token ? null : 'There is no sign-in token in this link.')

  useEffect(() => {
    if (!token) return
    let cancelled = false
    exchangeHandoff(token)
      .then((user) => {
        if (cancelled) return
        window.history.replaceState(null, '', '#/chat')
        onSignedIn(user)
      })
      .catch((err: unknown) => { if (!cancelled) setFailure(errorMessage(err)) })
    return () => { cancelled = true }
  }, [token, onSignedIn])

  const again = async () => {
    const url = await signInElsewhere()
    if (url) window.location.assign(url)
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bark-900)] p-6 text-slate-100">
      <div className="w-full max-w-sm space-y-4 rounded-2xl border border-[var(--bark-700)] bg-[var(--bark-800)] p-8 text-center">
        {failure ? (
          <>
            <p className="text-sm font-semibold">Could not sign you in here</p>
            <p className="text-xs text-rose-300">{failure}</p>
            <button type="button" onClick={() => void again()} className="rounded-md bg-[var(--leaf-stem)] px-3 py-1.5 text-xs font-medium text-white">Sign in again</button>
          </>
        ) : (
          <p className="flex items-center justify-center gap-2 text-sm text-slate-300"><Loader2 size={16} className="animate-spin" /> Signing you in…</p>
        )}
      </div>
    </div>
  )
}
