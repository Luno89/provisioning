import { CheckCircle2, Globe, XCircle } from 'lucide-react'
import type { EgressRequest } from '@koala/harness-types'

export interface EgressRequestCardProps {
  request: EgressRequest
  busy: boolean
  error?: string | undefined
  onAllow: () => void
  onDismiss: () => void
}

const STATUS_WORD: Record<EgressRequest['status'], string> = {
  requested: 'wants to reach this host from its workspace',
  allowed: 'may reach this host from its next run',
  dismissed: 'was not allowed to reach this host',
}

export default function EgressRequestCard({ request, busy, error, onAllow, onDismiss }: EgressRequestCardProps) {
  const where = `${request.host}${request.ports?.length ? `:${request.ports.join(',')}` : ''}`
  return (
    <div className="w-full p-3 my-2 rounded-md bg-[var(--bark-800)] border border-[var(--bark-700)] text-slate-200 text-xs flex flex-col gap-2" data-testid="egress-request">
      <div className="flex items-start gap-2">
        <Globe size={14} className="text-orange-400 shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-slate-100 font-mono">{where}</div>
          <div className="text-slate-400">{request.agentSlug} {STATUS_WORD[request.status]}</div>
        </div>
        {request.status === 'allowed' && <CheckCircle2 size={14} className="text-emerald-400 shrink-0" />}
        {request.status === 'dismissed' && <XCircle size={14} className="text-slate-500 shrink-0" />}
      </div>
      <div className="text-slate-300">{request.why}</div>
      <div className="text-slate-500">Allowing opens only this host, only for {request.agentSlug}. You can revoke it in the Studio.</div>
      {request.status === 'requested' && (
        <div className="flex gap-2">
          <button type="button" disabled={busy} onClick={onAllow} className="px-2 py-1 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 cursor-pointer">Allow</button>
          <button type="button" disabled={busy} onClick={onDismiss} className="px-2 py-1 rounded bg-[var(--bark-700)] hover:bg-[var(--bark-600)] disabled:opacity-50 cursor-pointer">Dismiss</button>
        </div>
      )}
      {error && <span className="text-red-400">{error}</span>}
    </div>
  )
}
