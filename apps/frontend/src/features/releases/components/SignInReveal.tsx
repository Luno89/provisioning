import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Copy, EyeOff, KeyRound } from 'lucide-react'
import { getSignIn, releaseKeys } from '../api/releases.js'
import { errorMessage } from '../../../api/client.js'

export function SignInReveal({ projectId }: { projectId: string }) {
  const [shown, setShown] = useState(false)
  const [copied, setCopied] = useState('')
  const signIn = useQuery({
    queryKey: releaseKeys.signIn(projectId),
    queryFn: () => getSignIn(projectId),
    enabled: shown,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  })

  const copy = (what: string, value: string) => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(what)
      setTimeout(() => setCopied(''), 1500)
    })
  }

  if (!shown) {
    return (
      <button
        type="button"
        onClick={() => setShown(true)}
        className="bg-[var(--bark-700)] hover:bg-[var(--bark-600)] text-slate-200 border border-[var(--bark-600)] text-[11px] font-medium px-2 py-0.5 rounded flex items-center gap-1 transition-colors shrink-0 cursor-pointer"
      >
        <KeyRound size={11} /> Show sign-in
      </button>
    )
  }

  return (
    <div className="w-full mt-2 rounded-md border border-[var(--bark-600)] bg-[var(--bark-900)] px-2.5 py-2 text-[11px] space-y-1.5" data-testid="sign-in">
      <div className="flex items-center justify-between">
        <span className="text-slate-400">Sign-in, from the project&apos;s vault</span>
        <button type="button" onClick={() => setShown(false)} className="flex items-center gap-1 text-slate-500 hover:text-slate-300 cursor-pointer">
          <EyeOff size={11} /> Hide
        </button>
      </div>
      {signIn.isLoading && <p className="text-slate-500">Reading the vault…</p>}
      {signIn.isError && <p className="text-rose-300">{errorMessage(signIn.error)}</p>}
      {signIn.data?.length === 0 && <p className="text-slate-500">No sign-in is in the project&apos;s vault yet.</p>}
      {signIn.data?.map((entry) => (
        <div key={entry.login} className="space-y-1">
          <p className="text-slate-500">{entry.describe}</p>
          {([['login', entry.login], ['password', entry.password]] as const).map(([what, value]) => (
            <div key={what} className="flex items-center gap-2">
              <span className="w-16 text-slate-500">{what}</span>
              <code className="font-mono text-slate-100 break-all">{value}</code>
              <button type="button" aria-label={`Copy the ${what}`} onClick={() => copy(`${entry.login}-${what}`, value)} className="text-slate-500 hover:text-slate-200 cursor-pointer">
                <Copy size={11} />
              </button>
              {copied === `${entry.login}-${what}` && <span className="text-emerald-400">copied</span>}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
