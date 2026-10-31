import { createServer, type AddressInfo, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { answerOf, MailReputation, reachPort25 } from './MailReputation.js';

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
});

describe('answerOf', () => {
  it('tells a name that is not there from a lookup that failed', async () => {
    expect(await answerOf(Promise.resolve(['127.0.0.2']))).toEqual({ found: ['127.0.0.2'] });
    expect(await answerOf(Promise.reject(missing()))).toEqual({ missing: true });
    expect(await answerOf(Promise.reject(Object.assign(new Error('queryA ESERVFAIL'), { code: 'ESERVFAIL' })))).toEqual({ error: 'ESERVFAIL' });
  });
});

describe('reachPort25', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

  it('answers ok when something listens and names the refusal when nothing does', async () => {
    server = createServer((socket) => socket.end());
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
    const { port } = server.address() as AddressInfo;
    expect(await reachPort25('127.0.0.1', port)).toEqual({ ok: true });
    await new Promise<void>((done) => server!.close(() => done()));
    server = undefined;
    expect(await reachPort25('127.0.0.1', port)).toEqual({ ok: false, error: 'ECONNREFUSED' });
    expect(await reachPort25('mail.invalid', port)).toMatchObject({ ok: false });
  });
});
