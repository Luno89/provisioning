import { errorMessage } from '../../../api/client'
import { useCan, useShellStore } from '../../platform'
import { dangerPanel, quietButton, useEndOtherSessions } from '../shared'

export function OtherSessions() {
  const managesAccount = useCan()('manage-own-account')
  const pushNotification = useShellStore((s) => s.pushNotification)
  const end = useEndOtherSessions(() => pushNotification({ type: 'info', message: 'Every other browser and device signed in as you is signed out.' }))
  if (!managesAccount) return null
  return (
    <div className={dangerPanel}>
      <div className="flex items-center justify-between mb-1">
        <h4 className="text-lg font-bold text-white">Signed in elsewhere</h4>
        <button type="button" className={quietButton} disabled={end.isPending} onClick={() => end.mutate()}>Sign out everywhere else</button>
      </div>
      <p className="text-xs text-slate-400">
        Ends every session but this one: other browsers, devices and anyone holding an old session cookie. Changing your password or two-factor settings does the same.
      </p>
      {end.isError && <div className="mt-2 text-sm text-red-300">{errorMessage(end.error)}</div>}
    </div>
  )
}
