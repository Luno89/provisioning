import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Copy, EyeOff, KeyRound } from 'lucide-react'
import { errorMessage } from '../../api/client'

export interface RevealedSignIn {
  describe: string
  login?: string
  password: string
}

export interface SignInRevealProps {
  queryKey: readonly unknown[]
  load: () => Promise<RevealedSignIn[]>
  source: string
  reading: string
  empty: string
}

export function SignInReveal({ queryKey, load, source, reading, empty }: SignInRevealProps) {
  const [shown, setShown] = useState(false)
  const [copied, setCopied] = useState('')
  const signIn = useQuery({
    queryKey,
    queryFn: load,
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
        <span className="text-slate-400">{source}</span>
        <button type="button" onClick={() => setShown(false)} className="flex items-center gap-1 text-slate-500 hover:text-slate-300 cursor-pointer">
          <EyeOff size={11} /> Hide
        </button>
      </div>
      {signIn.isLoading && <p className="text-slate-500">{reading}</p>}
      {signIn.isError && <p className="text-rose-300">{errorMessage(signIn.error)}</p>}
      {signIn.data?.length === 0 && <p className="text-slate-500">{empty}</p>}
      {signIn.data?.map((entry, index) => (
        <div key={`${entry.describe}-${index}`} className="space-y-1">
          <p className="text-slate-500">{entry.describe}</p>
          {([['login', entry.login], ['password', entry.password]] as const).filter((row): row is readonly ['login' | 'password', string] => Boolean(row[1])).map(([what, value]) => (
            <div key={what} className="flex items-center gap-2">
              <span className="w-16 text-slate-500">{what}</span>
              <code className="font-mono text-slate-100 break-all">{value}</code>
              <button type="button" aria-label={`Copy the ${what}`} onClick={() => copy(`${index}-${what}`, value)} className="text-slate-500 hover:text-slate-200 cursor-pointer">
                <Copy size={11} />
              </button>
              {copied === `${index}-${what}` && <span className="text-emerald-400">copied</span>}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
