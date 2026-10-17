import { Loader2 } from 'lucide-react'
import { errorMessage } from '../../api/client'
import { dangerPanel, quietButton, useInstanceAddresses, useSetNestedAddresses } from './shared'

export function InstanceAddresses() {
  const addresses = useInstanceAddresses()
  const change = useSetNestedAddresses()
  const view = addresses.data
  if (!view) return null

  const flat = `<app>-${view.name}.${view.domain}`
  const nested = `<app>.${view.name}.${view.domain}`
  const issuing = view.nested && view.state === 'issuing'

  return (
    <div className={dangerPanel} data-testid="instance-addresses">
      <h4 className="text-lg font-bold text-white mb-1">Addresses</h4>
      <p className="text-xs text-slate-400">
        Your instance is at <span className="font-mono text-slate-200">{view.name}.{view.domain}</span>. Apps you publish are
        addressed <span className="font-mono text-slate-200">{flat}</span>
        {view.nested ? <>, and also <span className="font-mono text-slate-200">{nested}</span></> : null}.
      </p>
      <div className="mt-3 space-y-2">
        {!view.nested && (
          <>
            <p className="text-xs text-slate-400">
              Nested addresses read <span className="font-mono text-slate-200">{nested}</span>. Switching gets your name a
              certificate of its own, which can take a few minutes; until it is issued your apps stay on their current addresses,
              and those keep working afterwards.
            </p>
            <button type="button" className={quietButton} disabled={change.isPending} onClick={() => change.mutate(true)}>Use nested addresses</button>
          </>
        )}
        {issuing && (
          <p className="flex items-center gap-2 text-xs text-amber-200"><Loader2 size={12} className="animate-spin" /> Getting the certificate for *.{view.name}.{view.domain}…</p>
        )}
        {issuing && view.detail && <p role="status" className="text-xs text-amber-300">{view.detail}</p>}
        {view.nested && view.state === 'ready' && <p className="text-xs text-emerald-300">Your apps show their nested addresses.</p>}
        {view.nested && (
          <button type="button" className={quietButton} disabled={change.isPending} onClick={() => change.mutate(false)}>Go back to flat addresses only</button>
        )}
        {change.isError && <p role="alert" className="text-xs text-red-300">{errorMessage(change.error)}</p>}
        {addresses.isError && <p role="alert" className="text-xs text-red-300">{errorMessage(addresses.error)}</p>}
      </div>
    </div>
  )
}
