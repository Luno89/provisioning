import dns from 'node:dns';
import dgram from 'node:dgram';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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

interface Zone { a?: string[]; ptr?: string[] }

const labelled = (name: string): Buffer => Buffer.concat([...name.split('.').filter(Boolean).map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])), Buffer.from([0])]);

function answerFor(query: Buffer, zones: Record<string, Zone>): Buffer {
  let at = 12;
  const labels: string[] = [];
  while (query[at] !== 0) {
    labels.push(query.subarray(at + 1, at + 1 + query[at]!).toString('latin1'));
    at += query[at]! + 1;
  }
  const questionEnd = at + 5;
  const type = query.readUInt16BE(at + 1);
  const zone = zones[labels.join('.')];
  const records = type === 1 ? (zone?.a ?? []).map((ip) => Buffer.from(ip.split('.').map(Number))) : type === 12 ? (zone?.ptr ?? []).map(labelled) : [];
  const header = Buffer.alloc(12);
  header.writeUInt16BE(query.readUInt16BE(0), 0);
  header.writeUInt16BE(0x8180 | (zone ? 0 : 3), 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(records.length, 6);
  const answers = records.map((data) => {
    const fixed = Buffer.alloc(12);
    fixed.writeUInt16BE(0xc00c, 0);
    fixed.writeUInt16BE(type, 2);
    fixed.writeUInt16BE(1, 4);
    fixed.writeUInt32BE(60, 6);
    fixed.writeUInt16BE(data.length, 10);
    return Buffer.concat([fixed, data]);
  });
  return Buffer.concat([header, query.subarray(12, questionEnd), ...answers]);
}

describe('MailReputation asking a real resolver', () => {
  let nameserver: dgram.Socket;
  let before: string[];
  const zones: Record<string, Zone> = {
    'mail.example.dev': { a: ['203.0.113.7'] },
    '7.113.0.203.in-addr.arpa': { ptr: ['mail.example.dev'] },
    '2.0.0.127.zen.spamhaus.org': { a: ['127.0.0.2'] },
    '2.0.0.127.b.barracudacentral.org': { a: ['127.0.0.2'] },
    '2.0.0.127.dnsbl-1.uceprotect.net': { a: ['127.0.0.2'] },
    '7.113.0.203.b.barracudacentral.org': { a: ['127.0.0.2'] },
  };

  beforeAll(async () => {
    nameserver = dgram.createSocket('udp4');
    nameserver.on('message', (query, remote) => { nameserver.send(answerFor(query, zones), remote.port, remote.address); });
    await new Promise<void>((listening) => nameserver.bind(0, '127.0.0.1', listening));
    before = dns.getServers();
    dns.setServers([`127.0.0.1:${nameserver.address().port}`]);
  });

  afterAll(async () => {
    dns.setServers(before);
    await new Promise<void>((closed) => nameserver.close(closed));
  });

  it('resolves the mail host, its reverse name and each list with the system resolver, finding the address on the one list that has it', async () => {
    const mail = new MailReputation({ domain: 'example.dev', reach25: async () => ({ ok: true }) });
    const result = await mail.check();
    expect(result).toMatchObject({ host: 'mail.example.dev', ip: '203.0.113.7', forward: { state: 'matches' }, reverseDns: { state: 'matches' }, port25: { open: true } });
    expect(result.blocklists.map((list) => list.state)).toEqual(['clear', 'listed', 'clear']);
  });

  it('says the mail host is not there when the resolver answers that no such name exists', async () => {
    const mail = new MailReputation({ domain: 'nowhere.example', reach25: async () => ({ ok: true }) });
    const result = await mail.check();
    expect(result.forward.state).toBe('none');
    expect(result.blocklists).toEqual([]);
  });
});
