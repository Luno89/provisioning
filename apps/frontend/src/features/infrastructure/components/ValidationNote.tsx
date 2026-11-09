import { AlertTriangle, Check, CircleHelp } from 'lucide-react'
import type { ValidationResult } from '../types/credentials'

const LOOKS = {
  valid: 'bg-green-500/10 border border-green-500/20 text-green-400',
  unchecked: 'bg-amber-500/10 border border-amber-500/20 text-amber-300',
  invalid: 'bg-red-500/10 border border-red-500/20 text-red-400',
} as const

export function ValidationNote({ result }: { result: ValidationResult }) {
  const state = result.valid ? 'valid' : result.unchecked ? 'unchecked' : 'invalid'
  return (
    <div role="status" data-state={state} className={`p-3 rounded-xl text-xs font-semibold flex items-center gap-2 ${LOOKS[state]}`}>
      {state === 'valid' ? <Check size={14} /> : state === 'unchecked' ? <CircleHelp size={14} /> : <AlertTriangle size={14} />}
      <span>{result.message}</span>
    </div>
  )
}
