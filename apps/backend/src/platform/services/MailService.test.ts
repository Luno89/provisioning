import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { interceptHttp } from '../testing/http.js';
import { MailError, MailService, type EmailWay } from './MailService.js';

const smtp: EmailWay = { kind: 'smtp', url: 'smtp://127.0.0.1:2525', from: 'alerts@example.dev' };
const root: EmailWay = { kind: 'root', rootUrl: 'https://app.example.dev', instanceId: 'inst-1', credential: 'cred-1' };
const message = { subject: 'Down', text: 'It is down' };

type Transport = NonNullable<ConstructorParameters<typeof MailService>[0]['transport']>;
type Sender = ReturnType<Transport>;

const withTransport = () => {
  const sender = mock<Sender>();
  const urls: string[] = [];
  const transport: Transport = (url) => { urls.push(url); return sender; };
  return { sender, urls, transport };
};

let received: { headers: Headers; body: unknown } | undefined;
interceptHttp(
  http.post('https://app.example.dev/api/instances/mail', async ({ request }) => {
    received = { headers: request.headers, body: await request.json() };
    return HttpResponse.json({ ok: true });
  }),
  http.post('https://refusing.example.dev/api/instances/mail', () => HttpResponse.json({ error: 'sixty an hour' }, { status: 429 })),
  http.post('https://mute.example.dev/api/instances/mail', () => new HttpResponse('boom', { status: 500 })),
);

describe('MailService', () => {
  it('says whether email can be sent and why not', () => {
    expect(new MailService({ way: smtp, emailOf: async () => undefined, transport: withTransport().transport }).available()).toEqual({ ok: true });
    expect(new MailService({ way: root, emailOf: async () => undefined }).available()).toEqual({ ok: true });
    expect(new MailService({ way: { kind: 'none', why: 'no mail here' }, emailOf: async () => undefined }).available()).toEqual({ ok: false, why: 'no mail here' });
  });

  it('opens an SMTP transport only when it sends by SMTP', () => {
    const smtpOnly = withTransport();
    new MailService({ way: smtp, emailOf: async () => undefined, transport: smtpOnly.transport });
    expect(smtpOnly.urls).toEqual(['smtp://127.0.0.1:2525']);
    const viaRoot = withTransport();
    new MailService({ way: root, emailOf: async () => undefined, transport: viaRoot.transport });
    expect(viaRoot.urls).toEqual([]);
  });

  it('sends to an address from the platform\'s own address by SMTP', async () => {
    const { sender, transport } = withTransport();
    sender.sendMail.mockResolvedValue(undefined);
    await new MailService({ way: smtp, emailOf: async () => undefined, transport }).toAddress('ann@example.com', message);
    expect(sender.sendMail).toHaveBeenCalledWith({ from: 'alerts@example.dev', to: 'ann@example.com', subject: 'Down', text: 'It is down' });
  });

  it('refuses to send to other people where it is not root, saying why', async () => {
    await expect(new MailService({ way: root, emailOf: async () => undefined }).toAddress('ann@example.com', message)).rejects.toMatchObject({ status: 503, message: 'only root sends email to other people' });
    await expect(new MailService({ way: { kind: 'none', why: 'no mail here' }, emailOf: async () => undefined }).toAddress('ann@example.com', message)).rejects.toMatchObject({ status: 503, message: 'no mail here' });
  });

  it('sends to the owner\'s address by SMTP, and refuses an owner with none', async () => {
    const { sender, transport } = withTransport();
    sender.sendMail.mockResolvedValue(undefined);
    const service = new MailService({ way: smtp, emailOf: async (id) => (id === 'ann' ? 'ann@example.com' : undefined), transport });
    await service.toOwner('ann', message);
    expect(sender.sendMail).toHaveBeenCalledWith({ from: 'alerts@example.dev', to: 'ann@example.com', subject: 'Down', text: 'It is down' });
    const failure = await service.toOwner('bo', message).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(MailError);
    expect(failure).toMatchObject({ status: 404, message: 'this account has no email address' });
  });

  it('refuses to send to an owner when email is not set up', async () => {
    await expect(new MailService({ way: { kind: 'none', why: 'no mail here' }, emailOf: async () => 'ann@example.com' }).toOwner('ann', message)).rejects.toMatchObject({ status: 503, message: 'no mail here' });
  });

  it('asks root to send it, with the instance\'s credential', async () => {
    await new MailService({ way: root, emailOf: async () => undefined }).toOwner('ann', message);
    expect(received?.headers.get('authorization')).toBe('Bearer cred-1');
    expect(received?.headers.get('x-instance-id')).toBe('inst-1');
    expect(received?.body).toEqual(message);
  });

  it('asks root with a fresh service token when it has a way to get one', async () => {
    await new MailService({ way: root, emailOf: async () => undefined, rootToken: async () => 'service-token' }).toOwner('ann', message);
    expect(received?.headers.get('authorization')).toBe('Bearer service-token');
  });

  it('tells why root refused, or its status when it gave no reason', async () => {
    const refused = new MailService({ way: { ...root, rootUrl: 'https://refusing.example.dev' }, emailOf: async () => undefined });
    await expect(refused.toOwner('ann', message)).rejects.toMatchObject({ status: 502, message: 'root did not send it (429): sixty an hour' });
    const mute = new MailService({ way: { ...root, rootUrl: 'https://mute.example.dev' }, emailOf: async () => undefined });
    await expect(mute.toOwner('ann', message)).rejects.toMatchObject({ status: 502, message: 'root did not send it (500): no reason given' });
  });

  it('lets a failed send through after counting it', async () => {
    const { sender, transport } = withTransport();
    sender.sendMail.mockRejectedValue(new Error('smtp down'));
    await expect(new MailService({ way: smtp, emailOf: async () => 'ann@example.com', transport }).toOwner('ann', message)).rejects.toThrow('smtp down');
  });
});
