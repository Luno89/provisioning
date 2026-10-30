import { errorMessage } from '../../../api/client'
import type { ConfirmWith } from '../../platform'
import type { Proof } from '../types'
import { emailField, proofAsked, quietButton, sendsCode, useSendConfirmCode } from '../shared'

export interface ProofFieldProps {
  confirmWith: ConfirmWith | undefined
  value: Proof
  onChange: (proof: Proof) => void
}

export function ProofField({ confirmWith, value, onChange }: ProofFieldProps) {
  const send = useSendConfirmCode()
  if (!sendsCode(confirmWith)) {
    return (
      <label className="block text-xs text-slate-400">
        {proofAsked(confirmWith)}
        <input type="password" className={`${emailField} mt-1`} value={value.password ?? ''} onChange={(event) => onChange({ password: event.target.value })} autoComplete="current-password" />
      </label>
    )
  }
  return (
    <div className="space-y-2">
      <label className="block text-xs text-slate-400">
        {proofAsked(confirmWith)}
        <input
          className={`${emailField} mt-1`}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          placeholder="123456"
          value={value.code ?? ''}
          onChange={(event) => onChange({ code: event.target.value.replace(/\D/g, '') })}
        />
      </label>
      <div className="flex items-center gap-3">
        <button type="button" className={quietButton} disabled={send.isPending} onClick={() => send.mutate()}>
          {send.isSuccess ? 'Send another code' : 'Send me a code'}
        </button>
        {send.isSuccess && <span className="text-xs text-slate-400">Sent. It works for five minutes.</span>}
        {send.isError && <span role="alert" className="text-xs text-red-300">{errorMessage(send.error)}</span>}
      </div>
    </div>
  )
}
