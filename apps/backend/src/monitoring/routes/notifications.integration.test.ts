import { matching } from '../../platform/lib/test-matchers.js';
import { afterEach, describe, expect, it } from 'vitest';
import axios from 'axios';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { notificationsRouter } from './notifications.js';
import { InstanceMailLimit } from '../../instances/services/InstanceMailLimit.js';
import { instancesRouter } from '../../instances/routes/instances.js';
import { MailService } from '../../platform/services/MailService.js';
import { NotificationService } from '../services/NotificationService.js';
import { PushService } from '../services/PushService.js';
import { vapidKeysFrom } from '../lib/web-push.js';
import type { InstanceService } from '../../instances/services/InstanceService.js';

let harness: Harness;
let sent: Array<{ to: string; subject: string }>;
afterEach(async () => { await harness.close(); });

const mailWith = (way: ConstructorParameters<typeof MailService>[0]['way']) => new MailService({
  way,
  emailOf: async (id) => (id === TEST_USER.id ? TEST_USER.email : id === 'owner-of-i1' ? 'owner@example.com' : undefined),
  transport: () => ({ sendMail: async (message) => { sent.push(message); } }),
});

describe('/api/notifications', () => {
  const mount = async (way: ConstructorParameters<typeof MailService>[0]['way']) => {
    sent = [];
    harness = await mountRouter({ prefix: '/api/notifications', router: (db) => {
      const mail = mailWith(way);
      return notificationsRouter({ notifications: new NotificationService({ store: db.monitoring, mail }), mail });
    } });
  };

  it('shows the choice, whether email works and the address, and changes the choice', async () => {
    await mount({ kind: 'smtp', url: 'smtp://x', from: 'Koala <alerts@koala.dev>' });
    expect((await axios.get(harness.url('/api/notifications'))).data).toEqual({ email: 'all', available: { ok: true }, address: TEST_USER.email });
    expect((await axios.put(harness.url('/api/notifications'), { email: 'down' })).data).toMatchObject({ email: 'down' });
    await expect(axios.put(harness.url('/api/notifications'), { email: 'loud' })).rejects.toMatchObject({ response: { status: 400 } });
  });

  it('sends a test email to the person\'s own address', async () => {
    await mount({ kind: 'smtp', url: 'smtp://x', from: 'Koala <alerts@koala.dev>' });
    expect((await axios.post(harness.url('/api/notifications/test-email'))).data).toEqual({ sent: true });
    expect(sent).toEqual([expect.objectContaining({ to: TEST_USER.email, subject: 'Koala can email you' })]);
  });

  it('says why a test cannot be sent where email is not set up', async () => {
    await mount({ kind: 'none', why: 'email is not set up on this platform (MAIL_SMTP_URL is unset)' });
    await expect(axios.post(harness.url('/api/notifications/test-email'))).rejects.toMatchObject({ response: { status: 503, data: { error: 'email is not set up on this platform (MAIL_SMTP_URL is unset)' } } });
  });
});

describe('root sending for an instance', () => {
  const instances = {
    ownerOf: async (id: unknown, credential: unknown) => (id === 'i1' && credential === 'cred' ? { ok: true as const, value: { ownerId: 'owner-of-i1' } } : { ok: false as const, status: 401, error: 'unknown instance or credential' }),
  } as unknown as InstanceService;

  const mount = async (mailLimit?: InstanceMailLimit) => {
    sent = [];
    harness = await mountRouter({ prefix: '/api/instances', router: () => instancesRouter({ instances, chart: async () => '', mail: mailWith({ kind: 'smtp', url: 'smtp://x', from: 'Koala <alerts@koala.dev>' }), ...(mailLimit ? { mailLimit } : {}) }) });
  };
  const as = (credential: string) => ({ headers: { 'x-instance-id': 'i1', authorization: `Bearer ${credential}` } });

  it('sends only to the instance\'s owner', async () => {
    await mount();
    expect((await axios.post(harness.url('/api/instances/mail'), { subject: 'Alert: x', text: 'y', to: 'someone@else.com' }, as('cred'))).data).toEqual({ sent: true });
    expect(sent).toEqual([expect.objectContaining({ to: 'owner@example.com', subject: 'Alert: x' })]);
  });

  it('refuses a wrong credential and a subject that would add headers', async () => {
    await mount();
    await expect(axios.post(harness.url('/api/instances/mail'), { subject: 'x', text: 'y' }, as('nope'))).rejects.toMatchObject({ response: { status: 401 } });
    await expect(axios.post(harness.url('/api/instances/mail'), { subject: 'x\nBcc: a@b.c', text: 'y' }, as('cred'))).rejects.toMatchObject({ response: { status: 400 } });
    expect(sent).toEqual([]);
  });

  it('sends sixty an hour, then holds the rest back and tells the owner once', async () => {
    let now = Date.parse('2026-10-26T12:00:00.000Z');
    await mount(new InstanceMailLimit(() => now));
    for (let index = 0; index < 60; index += 1) {
      expect((await axios.post(harness.url('/api/instances/mail'), { subject: `Alert ${index}`, text: 'y' }, as('cred'))).data).toEqual({ sent: true });
      now += 1000;
    }
    await expect(axios.post(harness.url('/api/instances/mail'), { subject: 'Alert 60', text: 'y' }, as('cred'))).rejects.toMatchObject({ response: { status: 429, data: { error: matching(/held back until 2026-10-26T13:00:00.000Z/) } } });
    await expect(axios.post(harness.url('/api/instances/mail'), { subject: 'Alert 61', text: 'y' }, as('cred'))).rejects.toMatchObject({ response: { status: 429 } });
    expect(sent.map((mail) => (mail as { subject: string }).subject).slice(-2)).toEqual(['Alert 59', 'Koala is holding back email from your instance']);
    expect(sent).toHaveLength(61);
    now = Date.parse('2026-10-26T13:00:00.500Z');
    expect((await axios.post(harness.url('/api/instances/mail'), { subject: 'Alert 62', text: 'y' }, as('cred'))).data).toEqual({ sent: true });
  });
});

describe('/api/notifications/push', () => {
  let pushed: string[];
  const mount = async (withPush = true) => {
    pushed = [];
    harness = await mountRouter({ prefix: '/api/notifications', router: (db) => {
      const mail = mailWith({ kind: 'none', why: 'no mail here' });
      const push = new PushService({ store: db.monitoring, vapid: vapidKeysFrom('v'.repeat(64)), send: async (subscription) => { pushed.push(subscription.endpoint); } });
      return notificationsRouter({ notifications: new NotificationService({ store: db.monitoring, mail, push }), mail, ...(withPush ? { push } : {}) });
    } });
  };
  const subscription = { endpoint: 'https://push.example/send/1', keys: { p256dh: 'p256', auth: 'auth' } };

  it('switches this device on and off, lists it, and sends it a test', async () => {
    await mount();
    const first = (await axios.get(harness.url('/api/notifications/push'))).data as { publicKey: string; devices: unknown[] };
    expect(first.publicKey).toBe(vapidKeysFrom('v'.repeat(64)).publicKey);
    expect(first.devices).toEqual([]);
    await expect(axios.post(harness.url('/api/notifications/push/test'))).rejects.toMatchObject({ response: { status: 409 } });
    const added = (await axios.post(harness.url('/api/notifications/push'), { subscription }, { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Version/18.0 Safari/605.1.15' } })).data as { devices: Array<{ id: string; label: string }> };
    expect(added.devices).toEqual([expect.objectContaining({ label: 'Safari on Mac' })]);
    expect((await axios.post(harness.url('/api/notifications/push/test'))).data).toEqual({ sent: 1 });
    expect(pushed).toEqual([subscription.endpoint]);
    await expect(axios.post(harness.url('/api/notifications/push'), { subscription: { endpoint: 'http://plain' } })).rejects.toMatchObject({ response: { status: 400 } });
    expect((await axios.delete<{ devices: unknown[] }>(harness.url(`/api/notifications/push/${added.devices[0]!.id}`))).data.devices).toEqual([]);
    await expect(axios.delete(harness.url('/api/notifications/push/nope'))).rejects.toMatchObject({ response: { status: 404 } });
  });

  it('says so where the server sends no push', async () => {
    await mount(false);
    await expect(axios.get(harness.url('/api/notifications/push'))).rejects.toMatchObject({ response: { status: 404 } });
  });
});
