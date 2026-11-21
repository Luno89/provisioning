import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import net, { type AddressInfo } from 'node:net';
import type { NextFunction, Request, Response } from 'express';
import { instancesRouter } from '../../instances/routes/instances.js';
import { InstanceService } from '../../instances/services/InstanceService.js';
import { testInstanceClients, tokenOfInstance } from '../../instances/testing/placed-koala.js';
import { InstanceMailLimit } from '../../instances/services/InstanceMailLimit.js';
import { mountRouter, TEST_USER, type Harness } from '../routes/test-harness.js';
import { MailError, MailService } from './MailService.js';

interface Received { from: string; to: string[]; data: string }

let sink: net.Server;
let smtpUrl: string;
let received: Received[];
let sockets: Set<net.Socket>;

const smtpSink = (): Promise<net.Server> => new Promise((resolve) => {
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    let buffer = '';
    let current: Received = { from: '', to: [], data: '' };
    let inData = false;
    socket.write('220 sink ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          current.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          received.push(current);
          current = { from: '', to: [], data: '' };
          socket.write('250 queued\r\n');
          continue;
        }
        const eol = buffer.indexOf('\r\n');
        if (eol < 0) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        const verb = line.split(' ')[0]!.toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') socket.write('250 sink\r\n');
        else if (verb === 'MAIL') { current.from = /<([^>]*)>/.exec(line)?.[1] ?? ''; socket.write('250 ok\r\n'); }
        else if (verb === 'RCPT') { current.to.push(/<([^>]*)>/.exec(line)?.[1] ?? ''); socket.write('250 ok\r\n'); }
        else if (verb === 'DATA') { inData = true; socket.write('354 go\r\n'); }
        else if (verb === 'QUIT') { socket.end('221 bye\r\n'); return; }
        else socket.write('250 ok\r\n');
      }
    });
  });
  server.listen(0, '127.0.0.1', () => resolve(server));
});

const headerOf = (message: Received, name: string): string | undefined =>
  new RegExp(`^${name}: (.*)$`, 'mi').exec(message.data)?.[1]?.trim();

beforeAll(async () => {
  received = [];
  sockets = new Set();
  sink = await smtpSink();
  smtpUrl = `smtp://127.0.0.1:${(sink.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => sink.close(() => resolve()));
});

beforeEach(() => { received = []; });

const message = { subject: 'Down', text: 'It is down' };
const smtp = (url = smtpUrl) => ({ kind: 'smtp' as const, url, from: 'alerts@example.dev' });

describe('MailService sending through a real SMTP server', () => {
  it('sends to an address from the platform\'s own address', async () => {
    await new MailService({ way: smtp(), emailOf: async () => undefined }).toAddress('ann@example.com', message);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ from: 'alerts@example.dev', to: ['ann@example.com'] });
    expect(headerOf(received[0]!, 'Subject')).toBe('Down');
    expect(received[0]!.data).toContain('It is down');
  });

  it('sends to the owner\'s address, and refuses an owner with none', async () => {
    const service = new MailService({ way: smtp(), emailOf: async (id) => (id === 'ann' ? 'ann@example.com' : undefined) });
    await service.toOwner('ann', message);
    expect(received[0]).toMatchObject({ to: ['ann@example.com'] });
    const failure = await service.toOwner('bo', message).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(MailError);
    expect(failure).toMatchObject({ status: 404, message: 'this account has no email address' });
    expect(received).toHaveLength(1);
  });

  it('lets a failed send through when nothing answers on the server\'s port', async () => {
    const closed = net.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    await expect(new MailService({ way: smtp(`smtp://127.0.0.1:${port}`), emailOf: async () => 'ann@example.com' }).toOwner('ann', message)).rejects.toThrow(/ECONNREFUSED/);
  });

  it('refuses to send to other people where it is not root, saying why', async () => {
    const root = { kind: 'root' as const, rootUrl: 'http://127.0.0.1:1', instanceId: 'inst-1' };
    await expect(new MailService({ way: root, emailOf: async () => undefined, rootToken: async () => 'service-token' }).toAddress('ann@example.com', message)).rejects.toMatchObject({ status: 503, message: 'only root sends email to other people' });
    await expect(new MailService({ way: { kind: 'none', why: 'no mail here' }, emailOf: async () => undefined }).toAddress('ann@example.com', message)).rejects.toMatchObject({ status: 503, message: 'no mail here' });
  });
});

describe('an instance asking root to send its owner email, over HTTP', () => {
  let harness: Harness;
  let limit: InstanceMailLimit;
  let clock: number;

  beforeAll(async () => {
    clock = Date.parse('2026-11-02T12:00:00Z');
    limit = new InstanceMailLimit(() => clock);
    harness = await mountRouter({
      prefix: '/api/instances',
      user: TEST_USER,
      router: async (db) => {
        await db.accounts.saveUser({ id: 'u1', email: 'owner@example.com' } as never);
        await db.instances.saveInstance({ id: 'inst-1', ownerId: 'u1', name: 'alice', status: 'ready', createdAt: 'then', updatedAt: 'then' } as never);
        await db.instances.saveInstance({ id: 'inst-2', ownerId: 'u1', name: 'bob', status: 'ready', createdAt: 'then', updatedAt: 'then' } as never);
        const rootMail = new MailService({ way: smtp(), emailOf: async (ownerId) => (await db.accounts.getUserById(ownerId))?.email });
        return instancesRouter({
          instances: new InstanceService(db, { rootUrl: 'https://app.koala.dev', rootPublicKeys: () => ['PEM'], registry: 'r', imageTag: 't', domain: 'koala.dev', ...testInstanceClients }, undefined),
          chart: async () => '',
          operatorOnly: (_req: Request, res: Response, _next: NextFunction) => { res.status(403).end(); },
          mail: rootMail,
          mailLimit: limit,
        });
      },
    });
  });

  afterAll(async () => { await harness.close(); });

  const instance = (token = tokenOfInstance('inst-1'), instanceId = 'inst-1') => new MailService({ way: { kind: 'root', rootUrl: harness.url(''), instanceId }, emailOf: async () => undefined, rootToken: async () => token });

  it('is sent by root to the instance owner\'s address, from root\'s own address', async () => {
    await instance().toOwner('u1', message);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ from: 'alerts@example.dev', to: ['owner@example.com'] });
    expect(headerOf(received[0]!, 'Subject')).toBe('Down');
  });

  it('is refused with root\'s reason when the token is not the instance\'s or the message is not one', async () => {
    await expect(instance('wrong').toOwner('u1', message)).rejects.toMatchObject({ status: 502, message: 'root did not send it (401): unknown instance or credential' });
    await expect(instance().toOwner('u1', { subject: '', text: 'x' })).rejects.toMatchObject({ status: 502, message: expect.stringContaining('root did not send it (400)') as unknown });
    expect(received).toEqual([]);
  });

  it('is held back past an hour\'s allowance, and tells the owner once that it is', async () => {
    for (let sent = 0; sent < 60; sent += 1) await instance(tokenOfInstance('inst-2'), 'inst-2').toOwner('u1', message);
    expect(received).toHaveLength(60);
    await expect(instance(tokenOfInstance('inst-2'), 'inst-2').toOwner('u1', message)).rejects.toMatchObject({ status: 502, message: expect.stringContaining('root did not send it (429): this instance has sent as many emails as an hour allows') as unknown });
    expect(received).toHaveLength(61);
    expect(headerOf(received[60]!, 'Subject')).toBe('Koala is holding back email from your instance');
    await expect(instance(tokenOfInstance('inst-2'), 'inst-2').toOwner('u1', message)).rejects.toMatchObject({ status: 502 });
    expect(received).toHaveLength(61);
  });
});
