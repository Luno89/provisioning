export type PushSupport = 'ready' | 'unsupported' | 'add-to-home-screen' | 'blocked'

export interface DeviceAbilities {
  serviceWorker: boolean
  pushManager: boolean
  permission: NotificationPermission | 'unsupported'
  appleMobile: boolean
  standalone: boolean
}

export function pushSupport(abilities: DeviceAbilities): PushSupport {
  if (abilities.appleMobile && !abilities.standalone) return 'add-to-home-screen'
  if (!abilities.serviceWorker || !abilities.pushManager || abilities.permission === 'unsupported') return 'unsupported'
  if (abilities.permission === 'denied') return 'blocked'
  return 'ready'
}

type PushWindow = Window & { Notification: typeof Notification }

export function abilitiesOf(win: PushWindow = window): DeviceAbilities {
  const agent = win.navigator.userAgent
  const appleMobile = /iPhone|iPad|iPod/.test(agent) || (/Macintosh/.test(agent) && win.navigator.maxTouchPoints > 1)
  const standalone = win.matchMedia?.('(display-mode: standalone)').matches === true || (win.navigator as Navigator & { standalone?: boolean }).standalone === true
  return {
    serviceWorker: 'serviceWorker' in win.navigator,
    pushManager: 'PushManager' in win,
    permission: 'Notification' in win ? win.Notification.permission : 'unsupported',
    appleMobile,
    standalone,
  }
}

export function applicationServerKey(publicKey: string): Uint8Array<ArrayBuffer> {
  const base64 = publicKey.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(publicKey.length / 4) * 4, '=')
  const raw = atob(base64)
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i)
  return bytes
}

async function registration(win: Window): Promise<ServiceWorkerRegistration> {
  return win.navigator.serviceWorker.ready
}

export async function subscribeThisDevice(publicKey: string, win: PushWindow = window): Promise<PushSubscriptionJSON> {
  const permission = await win.Notification.requestPermission()
  if (permission !== 'granted') throw new Error('Notifications were not allowed for Koala on this device. Allow them in the browser\'s site settings, then try again.')
  const ready = await registration(win)
  const existing = await ready.pushManager.getSubscription()
  const subscription = existing ?? await ready.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey(publicKey) })
  return subscription.toJSON()
}

export async function thisDeviceEndpoint(win: Window = window): Promise<string | undefined> {
  if (!('serviceWorker' in win.navigator)) return undefined
  const ready = await registration(win)
  return (await ready.pushManager.getSubscription())?.endpoint ?? undefined
}

export async function unsubscribeThisDevice(win: Window = window): Promise<void> {
  const ready = await registration(win)
  await (await ready.pushManager.getSubscription())?.unsubscribe()
}
