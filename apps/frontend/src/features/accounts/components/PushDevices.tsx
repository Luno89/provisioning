import { Loader2 } from 'lucide-react'
import { errorMessage } from '../../../api/client'
import { quietButton, thisDeviceSupport, useForgetPushDevice, useNotifyThisDevice, usePushDevices, useSendTestPush, useThisDeviceEndpoint } from '../shared'

const SUPPORT_SAID = {
  unsupported: 'This browser cannot receive notifications from Koala.',
  blocked: 'Notifications are blocked for Koala in this browser. Allow them in the browser\'s site settings to switch this device on.',
  'add-to-home-screen': 'On an iPhone or iPad, add Koala to your Home Screen first (Share → Add to Home Screen), open it from there, and switch it on in its Settings.',
} as const

export function PushDevices() {
  const push = usePushDevices()
  const thisEndpoint = useThisDeviceEndpoint()
  const notify = useNotifyThisDevice()
  const forget = useForgetPushDevice()
  const test = useSendTestPush()
  const view = push.data
  if (!view) return null
  const support = thisDeviceSupport()
  const thisDevice = view.devices.find((device) => device.endpoint === thisEndpoint.data)

  return (
    <div className="mt-4 space-y-2" data-testid="push-devices">
      <p className="text-xs font-semibold text-slate-200">Notify my devices</p>
      <p className="text-xs text-slate-400">
        Alerts, a run waiting for you to allow something, a release waiting for Cut over, and Koala's root not answering
        arrive on the devices you switch on here, even with Koala closed.
      </p>
      {support !== 'ready' && <p className="text-xs text-amber-300">{SUPPORT_SAID[support]}</p>}
      <div className="flex flex-wrap items-center gap-3">
        {!thisDevice && support === 'ready' && (
          <button type="button" className={quietButton} onClick={() => notify.mutate(view.publicKey)} disabled={notify.isPending}>
            {notify.isPending ? <Loader2 size={12} className="animate-spin" /> : 'Notify this device'}
          </button>
        )}
        {view.devices.length > 0 && (
          <button type="button" className={quietButton} onClick={() => test.mutate()} disabled={test.isPending}>
            {test.isPending ? <Loader2 size={12} className="animate-spin" /> : 'Send a test push'}
          </button>
        )}
        {test.isSuccess && <span className="text-xs text-emerald-300">Sent to {test.data.sent === 1 ? 'one device' : `${test.data.sent} devices`}.</span>}
        {test.isError && <span className="text-xs text-rose-300">{errorMessage(test.error)}</span>}
      </div>
      {notify.isError && <p className="text-xs text-rose-300">{errorMessage(notify.error)}</p>}
      {view.devices.length > 0 && (
        <ul className="space-y-1">
          {view.devices.map((device) => {
            const here = device.id === thisDevice?.id
            return (
              <li key={device.id} className="flex items-center justify-between gap-2 text-xs text-slate-300">
                <span>{device.label}{here ? <span className="text-slate-500"> · this device</span> : null}</span>
                <button
                  type="button"
                  className="text-slate-400 hover:text-white"
                  onClick={() => forget.mutate({ id: device.id, thisDevice: here })}
                  disabled={forget.isPending}
                  aria-label={`Stop notifying ${device.label}${here ? ' (this device)' : ''}`}
                >
                  Stop
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {forget.isError && <p className="text-xs text-rose-300">{errorMessage(forget.error)}</p>}
    </div>
  )
}

export default PushDevices
