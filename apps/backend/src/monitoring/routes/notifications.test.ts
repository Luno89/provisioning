import { afterEach, describe, expect, it } from 'vitest';
import axios from 'axios';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { notificationsRouter } from './notifications.js';
import { instancesRouter } from '../../instances/routes/instances.js';
import { MailService } from '../../platform/services/MailService.js';
import { NotificationService } from '../services/NotificationService.js';
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

  const mount = async () => {
    sent = [];
    harness = await mountRouter({ prefix: '/api/instances', router: () => instancesRouter({ instances, chart: async () => '', mail: mailWith({ kind: 'smtp', url: 'smtp://x', from: 'Koala <alerts@koala.dev>' }) }) });
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
});
