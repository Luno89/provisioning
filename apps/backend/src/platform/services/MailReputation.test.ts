import { EventEmitter } from 'node:events';
import { connect, type Socket } from 'node:net';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { answerOf, MailReputation, reachPort25 } from './MailReputation.js';

vi.mock('node:net', async (importOriginal) => ({ ...await importOriginal<typeof import('node:net')>(), connect: vi.fn() }));

const missing = () => Object.assign(new Error('queryA ENOTFOUND'), { code: 'ENOTFOUND' });

function dnsOf(records: Record<string, string[]>) {
  const asked: string[] = [];
  return {
    asked,
    resolve4: async (name: string) => {
      asked.push(name);
      const found = records[name];
      if (!found) throw missing();
      return found;
    },
  };
}

const socketThat = (happens: (socket: EventEmitter & { destroy: () => void }) => void) => {
  const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  queueMicrotask(() => happens(socket));
  return socket as unknown as Socket;
};

describe('MailReputation', () => {
  it('checks the mail host forwards and backwards, port 25 and each list through the resolver it is given', async () => {
    const dns = dnsOf({
      'mail.example.dev': ['203.0.113.7'],
      '2.0.0.127.zen.spamhaus.org': ['127.0.0.2'],
      '2.0.0.127.b.barracudacentral.org': ['127.0.0.2'],
      '2.0.0.127.dnsbl-1.uceprotect.net': ['127.0.0.2'],
      '7.113.0.203.dnsbl-1.uceprotect.net': ['127.0.0.2'],
    });
    const mail = new MailReputation({
      domain: 'example.dev',
      resolve4: dns.resolve4,
      reverse: async () => ['mail.example.dev'],
      reach25: async () => ({ ok: true }),
      now: () => new Date('2026-10-30T12:00:00Z'),
    });
    expect(mail.view()).toEqual({ checking: false });
    const result = await mail.check();
    expect(result).toMatchObject({ ip: '203.0.113.7', reverseDns: { state: 'matches' }, port25: { open: true }, checkedAt: '2026-10-30T12:00:00.000Z' });
    expect(result.blocklists.map((list) => list.state)).toEqual(['clear', 'clear', 'listed']);
    expect(mail.view().report?.problems).toEqual([expect.stringMatching(/^203\.0\.113\.7 is on UCEPROTECT level 1/)]);
    expect(dns.asked).toContain('7.113.0.203.zen.spamhaus.org');
  });

  it('runs one check at a time however often it is asked', async () => {
    let lookups = 0;
    const mail = new MailReputation({
      domain: 'example.dev',
      resolve4: async () => { lookups += 1; throw missing(); },
      reverse: async () => [],
      reach25: async () => ({ ok: false, error: 'ETIMEDOUT' }),
    });
    const [first, second] = await Promise.all([mail.check(), mail.check()]);
    expect(first).toBe(second);
    expect(lookups).toBe(1);
    expect(first.forward.state).toBe('none');
    expect(first.blocklists).toEqual([]);
    expect(mail.view().report?.problems).toEqual([first.forward.said, first.port25.said]);
  });

  it('shows that a check is running until it finishes, then the report', async () => {
    let finish: () => void = () => undefined;
    const mail = new MailReputation({
      domain: 'example.dev',
      ip: '203.0.113.7',
      resolve4: async () => { throw missing(); },
      reverse: async () => [],
      reach25: () => new Promise((done) => { finish = () => done({ ok: true }); }),
    });
    const running = mail.check();
    expect(mail.view()).toEqual({ checking: true });
    finish();
    await running;
    expect(mail.view().checking).toBe(false);
    expect(mail.view().report?.check.ip).toBe('203.0.113.7');
  });

  it('checks the address it was given rather than the one the name resolves to, and forgives port 25 behind a relay', async () => {
    const mail = new MailReputation({
      domain: 'example.dev',
      ip: '198.51.100.4',
      relayhost: 'smtp.relay.example',
      blocklists: [],
      resolve4: async () => ['203.0.113.7'],
      reverse: async (ip) => [ip === '198.51.100.4' ? 'mail.example.dev' : 'other.example'],
      reach25: async () => ({ ok: false, error: 'ETIMEDOUT' }),
    });
    const result = await mail.check();
    expect(result.ip).toBe('198.51.100.4');
    expect(result.forward.state).toBe('differs');
    expect(result.reverseDns?.state).toBe('matches');
    expect(result.port25.open).toBe(false);
    expect(mail.view().report?.problems.some((problem) => /relay/i.test(problem) && /25/.test(problem))).toBe(false);
  });

  it('probes with the node resolver and a real connection when it is given neither', async () => {
    vi.mocked(connect).mockImplementation(() => socketThat((socket) => socket.emit('connect')));
    const mail = new MailReputation({ domain: 'localhost.invalid', blocklists: [] });
    const result = await mail.check();
    expect(result.host).toBe('mail.localhost.invalid');
    expect(result.port25.open).toBe(true);
    expect(vi.mocked(connect)).toHaveBeenCalledWith(expect.objectContaining({ port: 25, family: 4 }));
  });
});

describe('answerOf', () => {
  it('tells a name that is not there from a lookup that failed', async () => {
    expect(await answerOf(Promise.resolve(['127.0.0.2']))).toEqual({ found: ['127.0.0.2'] });
    expect(await answerOf(Promise.resolve([]))).toEqual({ missing: true });
    expect(await answerOf(Promise.reject(missing()))).toEqual({ missing: true });
    expect(await answerOf(Promise.reject(Object.assign(new Error('queryA ESERVFAIL'), { code: 'ESERVFAIL' })))).toEqual({ error: 'ESERVFAIL' });
    expect(await answerOf(Promise.reject(new Error('no code at all')))).toEqual({ error: 'no code at all' });
  });
});

describe('reachPort25', () => {
  beforeEach(() => vi.mocked(connect).mockReset());

  it('answers ok and closes the connection when something listens', async () => {
    let opened: Socket | undefined;
    vi.mocked(connect).mockImplementation(() => (opened = socketThat((socket) => socket.emit('connect'))));
    expect(await reachPort25('mail.example.dev', 2525)).toEqual({ ok: true });
    expect(vi.mocked(connect)).toHaveBeenCalledWith({ host: 'mail.example.dev', port: 2525, family: 4 });
    expect(opened?.destroy).toHaveBeenCalled();
  });

  it('names the refusal when nothing listens, or the message when the error has no code', async () => {
    vi.mocked(connect).mockImplementationOnce(() => socketThat((socket) => socket.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))));
    expect(await reachPort25('mail.example.dev')).toEqual({ ok: false, error: 'ECONNREFUSED' });
    vi.mocked(connect).mockImplementationOnce(() => socketThat((socket) => socket.emit('error', new Error('odd'))));
    expect(await reachPort25('mail.example.dev')).toEqual({ ok: false, error: 'odd' });
  });
});
