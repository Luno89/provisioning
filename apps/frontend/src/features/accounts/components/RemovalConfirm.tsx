import { useState, type ReactNode } from 'react'
import { errorMessage } from '../../../api/client'
import { useShellStore } from '../../platform'
import { confirmMatches, dangerButton, emailField, proofReady, proofSent, useRemoveMyAccount } from '../shared'
import type { Proof } from '../types'
import { ProofField } from './ProofField'

export function RemovalBlockers({ blockers }: { blockers: readonly string[] }) {
  return (
    <ul className="text-sm text-amber-300 list-disc pl-5 space-y-1">
      {blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
    </ul>
  )
}

export function EmailConfirm({ email, typed, onType, purpose }: { email: string; typed: string; onType: (typed: string) => void; purpose: string }) {
  return (
    <label className="block text-xs text-slate-400">
      Type <span className="font-mono text-slate-200">{email}</span> {purpose}
      <input className={`${emailField} mt-1`} value={typed} onChange={(event) => onType(event.target.value)} autoComplete="off" />
    </label>
  )
}

export function MyRemovalConfirm({ email, remove, keep }: { email: string; remove: ReturnType<typeof useRemoveMyAccount>; keep: ReactNode }) {
  const [typed, setTyped] = useState('')
  const [proof, setProof] = useState<Proof>({})
  const confirmWith = useShellStore((s) => s.user?.confirmWith)
  return (
    <>
      <EmailConfirm email={email} typed={typed} onType={setTyped} purpose="to confirm" />
      <ProofField confirmWith={confirmWith} value={proof} onChange={setProof} />
      {remove.isError && <div role="alert" className="text-sm text-red-300">{errorMessage(remove.error)}</div>}
      <div className="flex gap-2">
        <button type="button" className={dangerButton} disabled={!confirmMatches(typed, email) || !proofReady(confirmWith, proof) || remove.isPending} onClick={() => remove.mutate({ confirm: typed, proof: proofSent(confirmWith, proof) })}>
          {remove.isPending ? 'Removing…' : 'Delete my account'}
        </button>
        {keep}
      </div>
    </>
  )
}
