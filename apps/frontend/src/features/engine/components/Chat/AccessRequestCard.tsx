import { CheckCircle2, ShieldAlert, XCircle } from 'lucide-react'
import type { AccessRequest } from '@koala/harness-types'

export interface AccessRequestCardProps {
  request: AccessRequest
  busy: boolean
  error?: string | undefined
  onGrant: () => void
  onDismiss: () => void
}

const STATUS_WORD: Record<AccessRequest['status'], string> = {
  requested: 'Koala asks to read these platform namespaces in this conversation',
  granted: 'Open to read-only diagnostics in this conversation',
  dismissed: 'Dismissed',
}

export default function AccessRequestCard({ request, busy, error, onGrant, onDismiss }: AccessRequestCardProps) {
  return (
    <div className="w-full p-3 my-2 rounded-md bg-[var(--bark-800)] border border-[var(--bark-700)] text-slate-200 text-xs flex flex-col gap-2" data-testid="access-request">
      <div className="flex items-start gap-2">
        <ShieldAlert size={14} className="text-rose-400 shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-slate-100 font-mono">{request.namespaces.join(', ')}</div>
          <div className="text-slate-400">{STATUS_WORD[request.status]}</div>
        </div>
        {request.status === 'granted' && <CheckCircle2 size={14} className="text-emerald-400 shrink-0" />}
        {request.status === 'dismissed' && <XCircle size={14} className="text-slate-500 shrink-0" />}
      </div>
      <div className="text-slate-300">{request.why}</div>
      <div className="text-slate-500">Read-only. Secrets and the vault stay closed. Only an administrator can grant this.</div>
      {request.status === 'requested' && (
        <div className="flex gap-2">
          <button type="button" disabled={busy} onClick={onGrant} className="px-2 py-1 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 cursor-pointer">Open them</button>
          <button type="button" disabled={busy} onClick={onDismiss} className="px-2 py-1 rounded bg-[var(--bark-700)] hover:bg-[var(--bark-600)] disabled:opacity-50 cursor-pointer">Dismiss</button>
        </div>
      )}
      {error && <span className="text-red-400">{error}</span>}
    </div>
  )
}
