import { Loader2 } from 'lucide-react'
import { errorMessage } from '../../api/client'
import type { EmailChoice } from '../../api/notifications'
import { dangerPanel, quietButton, useNotifications, useSendTestEmail, useSetEmailChoice } from './shared'

const CHOICES: Array<{ value: EmailChoice; label: string; explain: string }> = [
  { value: 'all', label: 'Every alert', explain: 'When any alert fires and when it resolves.' },
  { value: 'down', label: 'Only when something is down', explain: 'An app not answering, or a machine not ready.' },
  { value: 'off', label: 'No email', explain: 'Alerts still show as notices and on the Infrastructure page.' },
]

export function Notifications() {
  const notifications = useNotifications()
  const choose = useSetEmailChoice()
  const test = useSendTestEmail()
  const view = notifications.data
  if (!view) return null

  return (
    <div className={dangerPanel} data-testid="notifications">
      <h4 className="text-lg font-bold text-white mb-1">Notifications</h4>
      <p className="text-xs text-slate-400">
        Alerts reach you as a notice in the chat they belong to and on the Infrastructure page.
        {view.address ? <> They can also be emailed to <span className="font-mono text-slate-200">{view.address}</span>.</> : ' They can also be emailed to your account\'s address.'}
      </p>
      {!view.available.ok && <p className="mt-2 text-xs text-amber-300">Email cannot be sent from here: {view.available.why}.</p>}
      <fieldset className="mt-3 space-y-1.5" disabled={!view.available.ok || choose.isPending}>
        <legend className="sr-only">Email alerts</legend>
        {CHOICES.map((choice) => (
          <label key={choice.value} className="flex items-start gap-2 text-xs text-slate-300">
            <input
              type="radio"
              name="email-alerts"
              value={choice.value}
              checked={view.email === choice.value}
              onChange={() => choose.mutate(choice.value)}
              className="mt-0.5"
            />
            <span><span className="font-semibold text-slate-200">{choice.label}</span> <span className="text-slate-500">{choice.explain}</span></span>
          </label>
        ))}
      </fieldset>
      {choose.isError && <p className="mt-1 text-xs text-rose-300">{errorMessage(choose.error)}</p>}
      {view.available.ok && (
        <div className="mt-3 flex items-center gap-3">
          <button type="button" className={quietButton} onClick={() => test.mutate()} disabled={test.isPending}>
            {test.isPending ? <Loader2 size={12} className="animate-spin" /> : 'Send a test email'}
          </button>
          {test.isSuccess && <span className="text-xs text-emerald-300">Sent. Check your inbox, and your spam folder the first time.</span>}
          {test.isError && <span className="text-xs text-rose-300">{errorMessage(test.error)}</span>}
        </div>
      )}
    </div>
  )
}

export default Notifications
