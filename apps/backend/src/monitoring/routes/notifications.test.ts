import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { MailError, TEST_MAIL, type MailService } from '../../platform/index.js';
import { PERSON, routesInProcess } from '../../platform/testing/routes.js';
import type { NotificationService } from '../services/NotificationService.js';
import { PushError, type PushService } from '../services/PushService.js';
import { notificationsRouter } from './notifications.js';

type Notifications = Pick<NotificationService, 'view' | 'set'>;
type Mail = Pick<MailService, 'toOwner'>;
type Push = Pick<PushService, 'view' | 'subscribe' | 'remove' | 'test'>;

let notifications: MockProxy<Notifications>;
let mail: MockProxy<Mail>;
let push: MockProxy<Push>;

const call = async (path: string, method: 'GET' | 'PUT' | 'POST' | 'DELETE' = 'GET', body?: unknown, withPush = true, headers?: Record<string, string>) => {
  const routes = await routesInProcess({ prefix: '/api/notifications', router: () => notificationsRouter({ notifications, mail, ...(withPush ? { push } : {}) }), user: PERSON });
  return routes.request(method, `/api/notifications${path}`, { body, ...(headers ? { headers } : {}) });
};

beforeEach(() => {
  notifications = mock<Notifications>();
  mail = mock<Mail>();
  push = mock<Push>();
});

describe('/api/notifications', () => {
  it('shows the choice, whether email works and the address', async () => {
    notifications.view.calledWith(PERSON.id).mockResolvedValue({ email: 'all', available: { ok: true } });
    expect(await call('/')).toMatchObject({ status: 200, data: { email: 'all', available: { ok: true }, address: PERSON.email } });
  });

  it('leaves the address out for a person with none', async () => {
    notifications.view.mockResolvedValue({ email: 'all', available: { ok: true } });
    const routes = await routesInProcess({ prefix: '/api/notifications', router: () => notificationsRouter({ notifications, mail }), user: { id: 'u', email: '' } });
    const answer = await routes.get('/api/notifications/');
    expect(answer.data).toEqual({ email: 'all', available: { ok: true } });
  });

  it('changes the choice from the body\'s email', async () => {
    notifications.set.calledWith(PERSON.id, 'down').mockResolvedValue({ ok: true, value: { email: 'down', available: { ok: true } } });
    expect(await call('/', 'PUT', { email: 'down' })).toMatchObject({ status: 200, data: { email: 'down' } });
  });

  it('answers 400 with the words the service gave for a choice it refuses', async () => {
    notifications.set.mockResolvedValue({ ok: false, error: 'email is off, all or down' });
    expect(await call('/', 'PUT', { email: 'loud' })).toMatchObject({ status: 400, data: { error: 'email is off, all or down' } });
  });

  it('sends a test email to the person', async () => {
    mail.toOwner.mockResolvedValue(undefined);
    expect(await call('/test-email', 'POST')).toMatchObject({ status: 200, data: { sent: true } });
    expect(mail.toOwner).toHaveBeenCalledWith(PERSON.id, TEST_MAIL);
  });

  it('says why a test cannot be sent where email is not set up, and when sending fails otherwise', async () => {
    mail.toOwner.mockRejectedValueOnce(new MailError(503, 'email is not set up on this platform (MAIL_SMTP_URL is unset)'));
    expect(await call('/test-email', 'POST')).toMatchObject({ status: 503, data: { error: 'email is not set up on this platform (MAIL_SMTP_URL is unset)' } });
    mail.toOwner.mockRejectedValueOnce(new Error('connection refused'));
    expect(await call('/test-email', 'POST')).toMatchObject({ status: 502, data: { error: 'it could not be sent: connection refused' } });
  });
});

describe('/api/notifications/push', () => {
  const subscription = { endpoint: 'https://push.example/send/1', keys: { p256dh: 'p256', auth: 'auth' } };
  const view = { publicKey: 'public', devices: [] };

  it('lists the person\'s devices', async () => {
    push.view.calledWith(PERSON.id).mockResolvedValue(view);
    expect(await call('/push')).toMatchObject({ status: 200, data: view });
  });

  it('adds a device from the body\'s subscription and the browser it came from', async () => {
    push.subscribe.mockResolvedValue(view);
    expect(await call('/push', 'POST', { subscription }, true, { 'user-agent': 'Safari' })).toMatchObject({ status: 200, data: view });
    expect(push.subscribe).toHaveBeenCalledWith(PERSON.id, subscription, 'Safari');
  });

  it('removes a device by id', async () => {
    push.remove.calledWith(PERSON.id, 'd1').mockResolvedValue(view);
    expect(await call('/push/d1', 'DELETE')).toMatchObject({ status: 200, data: view });
  });

  it('sends a test push', async () => {
    push.test.calledWith(PERSON.id).mockResolvedValue({ sent: 1 });
    expect(await call('/push/test', 'POST')).toMatchObject({ status: 200, data: { sent: 1 } });
  });

  it('answers with the status and words a push refusal carries, and passes other failures on', async () => {
    push.test.mockRejectedValueOnce(new PushError(409, 'no device of yours is set to be notified'));
    expect(await call('/push/test', 'POST')).toMatchObject({ status: 409, data: { error: 'no device of yours is set to be notified' } });
    push.view.mockRejectedValueOnce(new Error('store is gone'));
    expect(await call('/push')).toMatchObject({ status: 500, data: { error: 'store is gone' } });
  });

  it('says so where the server sends no push', async () => {
    expect(await call('/push', 'GET', undefined, false)).toMatchObject({ status: 404, data: { error: 'this server sends no push notifications' } });
  });
});
