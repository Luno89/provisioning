import { useState } from 'react'
import { errorMessage } from '../../../api/client'
import { useCan, useShellStore, type AppUser } from '../../platform'
import type { Proof, TwoFactorChange, TwoFactorSaved } from '../types'
import { proofReady, proofSent, quietButton, useSaveTwoFactor } from '../shared'
import { ProofField } from './ProofField'

const savedOf = (user: AppUser): TwoFactorChange => ({
  enabled: user.twoFactorEnabled === true,
  preferredMethod: user.twoFactorPreferredMethod === 'sms' ? 'sms' : 'email',
  ...(user.twoFactorPhone ? { phone: user.twoFactorPhone } : {}),
})

const sameChange = (a: TwoFactorChange, b: TwoFactorChange): boolean =>
  a.enabled === b.enabled && (!a.enabled || (a.preferredMethod === b.preferredMethod && (a.preferredMethod !== 'sms' || (a.phone ?? '') === (b.phone ?? ''))))

export function TwoFactorSettings() {
  const managesAccount = useCan()('manage-own-account')
  const user = useShellStore((s) => s.user)
  const setUser = useShellStore((s) => s.setUser)
  const pushNotification = useShellStore((s) => s.pushNotification)
  const [draft, setDraft] = useState<TwoFactorChange | undefined>(undefined)
  const [proof, setProof] = useState<Proof>({})
  const save = useSaveTwoFactor((saved: TwoFactorSaved) => {
    const current = useShellStore.getState().user
    if (current) setUser({ ...current, ...saved })
    setDraft(undefined)
    setProof({})
    pushNotification({ type: 'info', message: 'Two-factor sign-in is saved. Every other browser and device signed in as you is signed out.' })
  })
  if (!managesAccount || !user) return null

  const saved = savedOf(user)
  const shown = draft ?? saved
  const changed = !sameChange(shown, saved)
  const edit = (change: Partial<TwoFactorChange>) => setDraft({ ...shown, ...change })

  return (
    <div className="pt-6 border-t border-slate-700" data-testid="two-factor">
      <h4 className="text-lg font-bold text-white mb-4">Two-factor sign-in</h4>
      <div className="space-y-4">
        <div className="flex items-center justify-between bg-slate-900/40 p-4 rounded-2xl border border-white/5">
          <div>
            <div className="text-sm font-bold text-white">Ask for a code at every sign-in</div>
            <div className="text-xs text-slate-400 mt-0.5">A six-digit code by email or text message, after your password.</div>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input type="checkbox" aria-label="Two-factor sign-in" checked={shown.enabled} onChange={(event) => edit({ enabled: event.target.checked })} className="sr-only peer" />
            <div className="w-11 h-6 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
          </label>
        </div>

        {shown.enabled && (
          <div className="space-y-4 pt-2">
            <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Send codes by
              <select
                value={shown.preferredMethod ?? 'email'}
                onChange={(event) => edit({ preferredMethod: event.target.value === 'sms' ? 'sms' : 'email' })}
                className="mt-2 block w-full px-4 py-3 bg-slate-900/50 border border-white/5 rounded-2xl text-white focus:outline-none focus:border-blue-500 normal-case tracking-normal font-normal"
              >
                <option value="email">Email</option>
                <option value="sms">Text message</option>
              </select>
            </label>
            {shown.preferredMethod === 'sms' && (
              <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider">
                Mobile phone number
                <input
                  type="text"
                  placeholder="e.g. +1234567890"
                  value={shown.phone ?? ''}
                  onChange={(event) => edit({ phone: event.target.value })}
                  className="mt-2 block w-full px-4 py-3 bg-slate-900/50 border border-white/5 rounded-2xl text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 normal-case tracking-normal font-normal"
                />
              </label>
            )}
          </div>
        )}

        {changed && (
          <div className="space-y-3 rounded-2xl border border-white/5 bg-slate-900/40 p-4">
            <p className="text-xs text-slate-400">Saving this signs out every other browser and device signed in as you.</p>
            <ProofField confirmWith={user.confirmWith} value={proof} onChange={setProof} />
            {save.isError && <div role="alert" className="text-sm text-red-300">{errorMessage(save.error)}</div>}
            <div className="flex gap-2">
              <button type="button" className={quietButton} disabled={!proofReady(user.confirmWith, proof) || save.isPending} onClick={() => save.mutate({ change: shown, proof: proofSent(user.confirmWith, proof) })}>
                {save.isPending ? 'Saving…' : 'Save'}
              </button>
              <button type="button" className={quietButton} onClick={() => { setDraft(undefined); setProof({}) }}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
