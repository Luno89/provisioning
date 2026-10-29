import { describe, expect, it, vi } from 'vitest'
import { applicationServerKey, pushSupport, subscribeThisDevice, type DeviceAbilities } from './this-device'

const able: DeviceAbilities = { serviceWorker: true, pushManager: true, permission: 'default', appleMobile: false, standalone: false }

describe('whether this device can be notified', () => {
  it('is ready in a browser with push, blocked once refused, and on an iPhone only from the Home Screen', () => {
    expect(pushSupport(able)).toBe('ready')
    expect(pushSupport({ ...able, permission: 'denied' })).toBe('blocked')
    expect(pushSupport({ ...able, pushManager: false })).toBe('unsupported')
    expect(pushSupport({ ...able, permission: 'unsupported' })).toBe('unsupported')
    expect(pushSupport({ ...able, appleMobile: true })).toBe('add-to-home-screen')
    expect(pushSupport({ ...able, appleMobile: true, standalone: true })).toBe('ready')
  })

  it('turns the instance\'s public key into the bytes the browser wants', () => {
    expect([...applicationServerKey('BAEC_w')]).toEqual([4, 1, 2, 255])
  })
})

describe('switching this device on', () => {
  const browser = (permission: NotificationPermission, existing?: PushSubscription) => {
    const subscribe = vi.fn(async () => ({ toJSON: () => ({ endpoint: 'https://push.example/new', keys: { p256dh: 'p', auth: 'a' } }) }))
    const win = {
      Notification: { requestPermission: vi.fn(async () => permission) },
      navigator: { serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription: async () => existing ?? null, subscribe } }) } },
    } as unknown as Window & { Notification: typeof Notification }
    return { win, subscribe }
  }

  it('asks for permission, then subscribes with the instance\'s key', async () => {
    const { win, subscribe } = browser('granted')
    expect(await subscribeThisDevice('BAEC_w', win)).toEqual({ endpoint: 'https://push.example/new', keys: { p256dh: 'p', auth: 'a' } })
    expect(subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: applicationServerKey('BAEC_w') })
  })

  it('keeps a subscription the browser already has, and stops when permission is refused', async () => {
    const existing = { toJSON: () => ({ endpoint: 'https://push.example/kept' }) } as unknown as PushSubscription
    const kept = browser('granted', existing)
    expect((await subscribeThisDevice('BAEC_w', kept.win)).endpoint).toBe('https://push.example/kept')
    expect(kept.subscribe).not.toHaveBeenCalled()
    await expect(subscribeThisDevice('BAEC_w', browser('denied').win)).rejects.toThrow(/were not allowed/)
  })
})
