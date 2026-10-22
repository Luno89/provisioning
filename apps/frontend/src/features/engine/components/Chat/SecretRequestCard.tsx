import { useState } from 'react'
import { CheckCircle2, KeyRound, XCircle } from 'lucide-react'
import type { SecretRequest } from '@koala/harness-types'

export interface SecretRequestCardProps {
  request: SecretRequest
  busy: boolean
  error?: string | undefined
  onSubmit: (value: string, done: () => void) => void
  onDismiss: () => void
}

const STATUS_WORD: Record<SecretRequest['status'], string> = {
  requested: 'Waiting for you to enter it',
  provided: 'In the vault',
  provisioned: 'Provisioned automatically',
  dismissed: 'Dismissed',
}

export default function SecretRequestCard({ request, busy, error, onSubmit, onDismiss }: SecretRequestCardProps) {
  const [value, setValue] = useState('')
  const open = request.status === 'requested'

  return (
    <div className="w-full p-3 my-2 rounded-md bg-[var(--bark-800)] border border-[var(--bark-700)] text-slate-200 text-xs flex flex-col gap-2" data-testid="secret-request">
      <div className="flex items-start gap-2">
        <KeyRound size={14} className="text-amber-400 shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-slate-100 font-mono">{request.key}</div>
          <div className="text-slate-400">{STATUS_WORD[request.status]}</div>
        </div>
        {(request.status === 'provided' || request.status === 'provisioned') && <CheckCircle2 size={14} className="text-emerald-400 shrink-0" />}
        {request.status === 'dismissed' && <XCircle size={14} className="text-slate-500 shrink-0" />}
      </div>
      <div className="text-slate-300">{request.description}</div>
      <div className="text-slate-500">
        The value goes straight into the vault and reaches the deployed service as the {request.key} environment variable. No agent ever sees it.
      </div>

      {open && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (value) onSubmit(value, () => setValue(''))
          }}
        >
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label={`Value for ${request.key}`}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            className="w-full px-2 py-1 rounded bg-[var(--bark-900)] border border-[var(--bark-700)] text-slate-100 font-mono"
          />
          <div className="flex gap-2">
            <button type="submit" disabled={busy || !value} className="px-2 py-1 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 cursor-pointer">
              Save to vault
            </button>
            <button type="button" disabled={busy} onClick={onDismiss} className="px-2 py-1 rounded bg-[var(--bark-700)] hover:bg-[var(--bark-600)] disabled:opacity-50 cursor-pointer">
              Dismiss
            </button>
          </div>
          {error && <span className="text-red-400">{error}</span>}
        </form>
      )}
    </div>
  )
}
