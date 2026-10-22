import { beforeEach, describe, expect, it } from 'vitest';
import { testDatabase } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import type { AlertEpisode } from '../lib/monitoring-records.js';
import { MailService } from '../../platform/services/MailService.js';
import { NotificationService } from './NotificationService.js';

const episode: AlertEpisode = { id: 'e1', ownerId: 'o', clusterId: 'c', key: 'k', name: 'NodeMemoryHighUtilization', summary: 'Memory is nearly full', about: { kind: 'cluster' }, startedAt: 'then' };

let db: MongoDB;
let sent: Array<{ from: string; to: string; subject: string }>;

const service = (way: ConstructorParameters<typeof MailService>[0]['way']) => {
  const mail = new MailService({ way, emailOf: async (id) => (id === 'o' ? 'owner@example.com' : undefined), transport: () => ({ sendMail: async (message) => { sent.push(message); } }) });
  return { mail, notifications: new NotificationService({ store: db, mail, publicUrl: 'https://app.koala.dev', now: () => 'now' }) };
};

beforeEach(async () => {
  db = await testDatabase();
  sent = [];
});

describe('emailing alerts', () => {
  it('emails every alert to the account\'s address until the person narrows it', async () => {
    const { notifications } = service({ kind: 'smtp', url: 'smtp://x', from: 'Koala <alerts@koala.dev>' });
    expect(await notifications.alert(episode, 'fired')).toBe(true);
    expect(sent).toEqual([expect.objectContaining({ from: 'Koala <alerts@koala.dev>', to: 'owner@example.com', subject: 'Alert: Memory is nearly full' })]);

    expect(await notifications.set('o', 'down')).toMatchObject({ ok: true, value: { email: 'down' } });
    expect(await notifications.alert(episode, 'fired')).toBe(false);
    expect(await notifications.alert({ ...episode, name: 'AppProbeDown' }, 'fired')).toBe(true);
    expect(sent).toHaveLength(2);
  });

  it('refuses a choice it does not know', async () => {
    expect(await service({ kind: 'none', why: 'off' }).notifications.set('o', 'sometimes')).toEqual({ ok: false, error: 'email is off, all or down' });
  });

  it('sends nothing and says why where email is not set up', async () => {
    const { notifications, mail } = service({ kind: 'none', why: 'email is not set up on this platform (MAIL_SMTP_URL is unset)' });
    expect(await notifications.alert(episode, 'fired')).toBe(false);
    expect((await notifications.view('o')).available).toEqual({ ok: false, why: 'email is not set up on this platform (MAIL_SMTP_URL is unset)' });
    await expect(mail.toOwner('o', { subject: 's', text: 't' })).rejects.toMatchObject({ status: 503 });
  });
});

describe('an instance\'s email', () => {
  it('goes to root with the instance\'s credential, never to an address the instance names', async () => {
    const asked: Array<{ url: string; init: RequestInit }> = [];
    const mail = new MailService({
      way: { kind: 'root', rootUrl: 'https://app.koala.dev', instanceId: 'i1', credential: 'cred' },
      emailOf: async () => { throw new Error('an instance never looks up an address'); },
      fetchImpl: (async (url: string, init: RequestInit) => { asked.push({ url, init }); return new Response(JSON.stringify({ sent: true }), { status: 200 }); }) as typeof fetch,
    });
    await mail.toOwner('o', { subject: 'Alert: x', text: 'y' });
    expect(asked[0]?.url).toBe('https://app.koala.dev/api/instances/mail');
    expect(asked[0]?.init.headers).toMatchObject({ 'x-instance-id': 'i1', authorization: 'Bearer cred' });
    expect(JSON.parse(String(asked[0]?.init.body))).toEqual({ subject: 'Alert: x', text: 'y' });
  });

  it('says what root answered when it would not send', async () => {
    const mail = new MailService({
      way: { kind: 'root', rootUrl: 'https://r', instanceId: 'i1', credential: 'bad' },
      emailOf: async () => undefined,
      fetchImpl: (async () => new Response(JSON.stringify({ error: 'unknown instance or credential' }), { status: 401 })) as typeof fetch,
    });
    await expect(mail.toOwner('o', { subject: 's', text: 't' })).rejects.toThrow('root did not send it (401): unknown instance or credential');
  });
});
