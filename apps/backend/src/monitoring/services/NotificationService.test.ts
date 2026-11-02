import { beforeEach, describe, expect, it } from 'vitest';
import { matches, mock, type MockProxy } from 'vitest-mock-extended';
import type { Database } from '../../platform/lib/db-interface.js';
import type { MailMessage } from '../../platform/lib/mail.js';
import type { MailService } from '../../platform/services/MailService.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import type { AlertEpisode } from '../lib/monitoring-records.js';
import type { PushMessage } from '../lib/web-push.js';
import { NotificationService } from './NotificationService.js';
import type { PushService } from './PushService.js';

const episode: AlertEpisode = { id: 'e1', ownerId: 'o', clusterId: 'c', key: 'k', name: 'NodeMemoryHighUtilization', summary: 'Memory is nearly full', about: { kind: 'cluster' }, startedAt: 'then' };
const bySubject = (subject: string) => matches<MailMessage>((message) => message.subject === subject);

let db: Database;
let mail: MockProxy<Pick<MailService, 'available' | 'toOwner'>>;
let push: MockProxy<Pick<PushService, 'toPerson'>>;
let logged: string[];

const notifications = (withPush = false) => new NotificationService({
  store: db.monitoring,
  mail,
  ...(withPush ? { push } : {}),
  publicUrl: 'https://app.koala.dev',
  now: () => 'now',
  log: (message) => { logged.push(message); },
});

beforeEach(() => {
  db = memoryDatabase();
  mail = mock<Pick<MailService, 'available' | 'toOwner'>>();
  mail.available.mockReturnValue({ ok: true });
  mail.toOwner.mockResolvedValue(undefined);
  push = mock<Pick<PushService, 'toPerson'>>();
  push.toPerson.mockResolvedValue(1);
  logged = [];
});

describe('emailing alerts', () => {
  it('emails every alert to the owner until the person narrows it', async () => {
    const service = notifications();
    expect(await service.alert(episode, 'fired')).toBe(true);
    expect(mail.toOwner).toHaveBeenCalledWith('o', bySubject('Alert: Memory is nearly full'));

    expect(await service.set('o', 'down')).toMatchObject({ ok: true, value: { email: 'down' } });
    expect(await service.alert(episode, 'fired')).toBe(false);
    expect(await service.alert({ ...episode, name: 'AppProbeDown' }, 'fired')).toBe(true);
    expect(mail.toOwner).toHaveBeenCalledTimes(2);
  });

  it('keeps the choice as it was saved, and answers all before one is saved', async () => {
    const service = notifications();
    expect(await service.choiceOf('o')).toBe('all');
    await service.set('o', 'off');
    expect(await service.choiceOf('o')).toBe('off');
    expect(await service.choiceOf('someone')).toBe('all');
    expect(await db.monitoring.getNotificationSettings('o')).toEqual({ ownerId: 'o', email: 'off', updatedAt: 'now' });
  });

  it('refuses a choice it does not know and saves nothing', async () => {
    expect(await notifications().set('o', 'sometimes')).toEqual({ ok: false, error: 'email is off, all or down' });
    expect(await db.monitoring.getNotificationSettings('o')).toBeUndefined();
  });

  it('sends nothing and says why where email is not set up', async () => {
    mail.available.mockReturnValue({ ok: false, why: 'email is not set up on this platform (MAIL_SMTP_URL is unset)' });
    const service = notifications();
    expect(await service.alert(episode, 'fired')).toBe(false);
    expect(mail.toOwner).not.toHaveBeenCalled();
    expect(await service.view('o')).toEqual({ email: 'all', available: { ok: false, why: 'email is not set up on this platform (MAIL_SMTP_URL is unset)' } });
  });
});

describe('pushing alerts', () => {
  it('pushes what the person chose to hear about to their devices, with or without email', async () => {
    mail.available.mockReturnValue({ ok: false, why: 'no mail' });
    const service = notifications(true);
    expect(await service.alert(episode, 'fired')).toBe(false);
    expect(push.toPerson).toHaveBeenCalledTimes(1);
    expect(push.toPerson).toHaveBeenCalledWith('o', matches<PushMessage>((message) => message.title === 'Alert: NodeMemoryHighUtilization'));
    await service.set('o', 'off');
    await service.alert(episode, 'resolved');
    expect(push.toPerson).toHaveBeenCalledTimes(1);
  });

  it('logs a push that failed and still emails', async () => {
    push.toPerson.mockRejectedValue(new Error('push service is away'));
    expect(await notifications(true).alert(episode, 'fired')).toBe(true);
    expect(logged).toEqual(['[alerts] could not push to o: push service is away']);
    expect(mail.toOwner).toHaveBeenCalledTimes(1);
  });
});
