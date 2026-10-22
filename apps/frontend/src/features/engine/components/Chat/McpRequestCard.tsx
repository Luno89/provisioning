import { CheckCircle2, Plug, XCircle } from 'lucide-react'
import type { McpRequest } from '@koala/harness-types'

export interface McpRequestCardProps {
  request: McpRequest
  busy: boolean
  error?: string | undefined
  onEnable: () => void
  onDismiss: () => void
}

const STATUS_WORD: Record<McpRequest['status'], string> = {
  requested: 'Koala asks to switch this on for this conversation',
  enabled: 'Switched on for this conversation',
  dismissed: 'Dismissed',
}

export default function McpRequestCard({ request, busy, error, onEnable, onDismiss }: McpRequestCardProps) {
  return (
    <div className="w-full p-3 my-2 rounded-md bg-[var(--bark-800)] border border-[var(--bark-700)] text-slate-200 text-xs flex flex-col gap-2" data-testid="mcp-request">
      <div className="flex items-start gap-2">
        <Plug size={14} className="text-sky-400 shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-slate-100">{request.server}</div>
          <div className="text-slate-400">{STATUS_WORD[request.status]}</div>
        </div>
        {request.status === 'enabled' && <CheckCircle2 size={14} className="text-emerald-400 shrink-0" />}
        {request.status === 'dismissed' && <XCircle size={14} className="text-slate-500 shrink-0" />}
      </div>
      <div className="text-slate-300">{request.why}</div>
      {request.status === 'requested' && (
        <div className="flex gap-2">
          <button type="button" disabled={busy} onClick={onEnable} className="px-2 py-1 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 cursor-pointer">
            Switch it on
          </button>
          <button type="button" disabled={busy} onClick={onDismiss} className="px-2 py-1 rounded bg-[var(--bark-700)] hover:bg-[var(--bark-600)] disabled:opacity-50 cursor-pointer">
            Dismiss
          </button>
        </div>
      )}
      {error && <span className="text-red-400">{error}</span>}
    </div>
  )
}
