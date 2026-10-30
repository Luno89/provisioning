import { useState } from 'react'
import { errorMessage } from '../../../api/client'
import { useCan, useShellStore } from '../../platform'
import type { Proof } from '../types'
import { dangerPanel, emailField, newPasswordProblem, proofSent, quietButton, useChangePassword } from '../shared'
import { ProofField } from './ProofField'

export function ChangePassword() {
  const managesAccount = useCan()('manage-own-account')
  const user = useShellStore((s) => s.user)
  const pushNotification = useShellStore((s) => s.pushNotification)
  const [open, setOpen] = useState(false)
  const [current, setCurrent] = useState('')
  const [password, setPassword] = useState('')
  const [repeated, setRepeated] = useState('')
  const [proof, setProof] = useState<Proof>({})
  const close = () => {
    setOpen(false)
    setCurrent('')
    setPassword('')
    setRepeated('')
    setProof({})
  }
  const change = useChangePassword(() => {
    close()
    pushNotification({ type: 'info', message: 'Your password is changed. Every other browser and device signed in as you is signed out.' })
  })
  if (!managesAccount || !user) return null

  const hasPassword = user.hasPassword !== false
  const asksCode = Boolean(user.twoFactorEnabled) || !hasPassword
  const weak = newPasswordProblem(password, repeated)
  const ready = !weak && (!hasPassword || current.length > 0) && (!asksCode || /^\d{6}$/.test(proof.code ?? ''))
  const submit = () => change.mutate({
    password,
    ...(hasPassword ? { current } : {}),
    ...(asksCode ? proofSent(user.twoFactorEnabled ? 'two-factor' : 'email-code', proof) : {}),
  })

  return (
    <div className={dangerPanel} data-testid="change-password">
      <div className="flex items-center justify-between mb-1">
        <h4 className="text-lg font-bold text-white">Password</h4>
        {!open && <button type="button" className={quietButton} onClick={() => setOpen(true)}>{hasPassword ? 'Change password' : 'Set a password'}</button>}
      </div>
      <p className="text-xs text-slate-400">
        At least twelve characters, and not one leaked from another site. Changing it signs out every other browser and device signed in as you.
      </p>
      {open && (
        <form className="mt-4 space-y-3" onSubmit={(event) => { event.preventDefault(); if (ready) submit() }}>
          {hasPassword && (
            <label className="block text-xs text-slate-400">
              Current password
              <input type="password" className={`${emailField} mt-1`} value={current} onChange={(event) => setCurrent(event.target.value)} autoComplete="current-password" />
            </label>
          )}
          <label className="block text-xs text-slate-400">
            New password
            <input type="password" className={`${emailField} mt-1`} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" />
          </label>
          <label className="block text-xs text-slate-400">
            New password again
            <input type="password" className={`${emailField} mt-1`} value={repeated} onChange={(event) => setRepeated(event.target.value)} autoComplete="new-password" />
          </label>
          {password && weak && <div className="text-xs text-amber-300">{weak}</div>}
          {asksCode && <ProofField confirmWith={user.twoFactorEnabled ? 'two-factor' : 'email-code'} value={proof} onChange={setProof} />}
          {change.isError && <div role="alert" className="text-sm text-red-300">{errorMessage(change.error)}</div>}
          <div className="flex gap-2">
            <button type="submit" className={quietButton} disabled={!ready || change.isPending}>{change.isPending ? 'Changing…' : 'Change password'}</button>
            <button type="button" className={quietButton} onClick={close}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  )
}
