import { describe, expect, expectTypeOf, it } from 'vitest'
import { type NotificationView, type PushView, addPushDevice, getNotifications, getPush, removePushDevice, sendTestEmail, sendTestPush, setEmailChoice } from './notifications'
import { startBackend } from '../../../test/backend/site'
import { DATA_KEY } from '../../../test/backend/machines'
import type { Wire } from '../../../test/backend/wire'
import { notificationsRouter } from '../../../../../backend/src/monitoring/routes/notifications'
import { NotificationService, type NotificationView as BackendNotificationView } from '../../../../../backend/src/monitoring/services/NotificationService'
import { PushService, type PushView as BackendPushView } from '../../../../../backend/src/monitoring/services/PushService'
import { MailService } from '../../../../../backend/src/platform/services/MailService'
import { vapidKeysFrom } from '../../../../../backend/src/monitoring/lib/web-push'
import { TEST_MAIL } from '../../../../../backend/src/platform/lib/mail'
import { anyOf } from '../../../../../backend/src/platform/lib/test-matchers'

const sentMail: { to: string; subject: string }[] = []
const pushed: { endpoint: string; payload: string }[] = []
const vapid = vapidKeysFrom(DATA_KEY)

const backend = await startBackend(({ api, db, origin }) => {
  const mail = new MailService({
    way: { kind: 'smtp', url: 'smtp://127.0.0.1:2525', from: 'alerts@koala.test' },
    emailOf: async (ownerId) => (await db.accounts.getUserById(ownerId))?.email,
    transport: () => ({ sendMail: async (message) => { sentMail.push({ to: message.to, subject: message.subject }) } }),
  })
  const push = new PushService({ store: db.monitoring, vapid, send: async (subscription, payload) => { pushed.push({ endpoint: subscription.endpoint, payload }) } })
  api.use('/notifications', notificationsRouter({ notifications: new NotificationService({ store: db.monitoring, mail, push, publicUrl: origin }), mail, push }))
})

const owner = await backend.signIn()
const SUBSCRIPTION = { endpoint: 'https://push.example.org/send/abc', keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' } }

describe('the shapes the browser reads are the shapes the backend sends', () => {
  it('reads the notification settings and the person\'s devices as the backend describes them', () => {
    expectTypeOf<Wire<BackendNotificationView & { address: string }>>().toExtend<NotificationView>()
    expectTypeOf<Wire<BackendPushView>>().toExtend<PushView>()
  })
})

describe('Settings → Notifications, as its page asks for it', () => {
  it('reads every alert by email as the default, with email available and the address it goes to', async () => {
    expect(await getNotifications()).toEqual({ email: 'all', available: { ok: true }, address: owner.email })
  })

  it('changes the choice to only "down" alerts and reads it back', async () => {
    expect(await setEmailChoice('down')).toEqual({ email: 'down', available: { ok: true } })
    expect((await getNotifications()).email).toBe('down')
  })

  it('refuses a choice that is not one, saying which are', async () => {
    await expect(setEmailChoice('sometimes' as 'all')).rejects.toMatchObject({ response: { status: 400, data: { error: 'email is off, all or down' } } })
  })

  it('sends a test email to the person\'s own address', async () => {
    await sendTestEmail()
    expect(sentMail).toEqual([{ to: owner.email, subject: TEST_MAIL.subject }])
  })
})

describe('Notify this device, as the page asks for it', () => {
  it('reads the key a browser subscribes with and no devices yet', async () => {
    expect(await getPush()).toEqual({ publicKey: vapid.publicKey, devices: [] })
  })

  it('refuses a test push while no device is set to be notified', async () => {
    await expect(sendTestPush()).rejects.toMatchObject({ response: { status: 409, data: { error: 'no device of yours is set to be notified; switch it on on this device first' } } })
  })

  it('adds the browser\'s subscription and lists the device', async () => {
    const view = await addPushDevice(SUBSCRIPTION)
    expect(view.devices).toEqual([{ id: anyOf(String), label: anyOf(String), endpoint: SUBSCRIPTION.endpoint, createdAt: anyOf(String) }])
  })

  it('refuses a subscription that is not one', async () => {
    await expect(addPushDevice({ endpoint: 'http://push.example.org/send/abc', keys: SUBSCRIPTION.keys })).rejects.toMatchObject({ response: { status: 400, data: { error: 'a push service is reached over https' } } })
  })

  it('sends a test push to that device', async () => {
    expect(await sendTestPush()).toEqual({ sent: 1 })
    expect(pushed.map((push) => push.endpoint)).toEqual([SUBSCRIPTION.endpoint])
  })

  it('removes the device, and answers 404 for one that is not the person\'s', async () => {
    const [device] = (await getPush()).devices
    expect(await removePushDevice(device!.id)).toEqual({ publicKey: vapid.publicKey, devices: [] })
    await expect(removePushDevice(device!.id)).rejects.toMatchObject({ response: { status: 404, data: { error: 'no device of yours has that id' } } })
  })
})
