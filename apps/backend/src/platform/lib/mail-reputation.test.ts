import { matching } from './test-matchers.js';
import { describe, expect, it } from 'vitest';
import {
  blocklistQuery, blocklistVerdict, forwardVerdict, mailCheckFrom, MAIL_BLOCKLISTS, MAIL_CHECK_MARK, mailDomainFrom, mailLines, mailProblems,
  mailUnknowns, port25Verdict, reverseDnsVerdict, type MailReadiness,
} from './mail-reputation.js';

const zen = MAIL_BLOCKLISTS[0]!;

describe('blocklist queries', () => {
  it('reverses the address under the list', () => {
    expect(blocklistQuery('203.0.113.7', 'zen.spamhaus.org')).toBe('7.113.0.203.zen.spamhaus.org');
    expect(blocklistQuery('127.0.0.2', 'b.barracudacentral.org')).toBe('2.0.0.127.b.barracudacentral.org');
  });

  it('refuses what is not an IPv4 address', () => {
    expect(() => blocklistQuery('2001:db8::1', 'zen.spamhaus.org')).toThrow(/not an IPv4/);
    expect(() => blocklistQuery('300.1.1.1', 'zen.spamhaus.org')).toThrow(/not an IPv4/);
  });
});

describe('blocklistVerdict', () => {
  const listedTest = { found: ['127.0.0.2', '127.0.0.4'] };

  it('is clear only when the list answers for its own test address', () => {
    expect(blocklistVerdict(zen, '203.0.113.7', listedTest, { missing: true })).toMatchObject({ state: 'clear', said: '203.0.113.7 is not on Spamhaus ZEN' });
    expect(blocklistVerdict(zen, '203.0.113.7', { missing: true }, { missing: true })).toMatchObject({ state: 'unknown', said: matching(/does not answer for its own test address 127\.0\.0\.2/) });
  });

  it('is listed with the codes and where to ask for removal', () => {
    expect(blocklistVerdict(zen, '203.0.113.7', listedTest, { found: ['127.0.0.3'] })).toMatchObject({ state: 'listed', codes: ['127.0.0.3'], removal: 'https://check.spamhaus.org/' });
  });

  it('reads Spamhaus\'s answers to a public resolver as not asked, never as listed', () => {
    const viaPublic = { found: ['127.255.255.254'] };
    expect(blocklistVerdict(zen, '203.0.113.7', viaPublic, viaPublic)).toMatchObject({ state: 'unknown', said: matching(/refuses queries that come through a public resolver/) });
    expect(blocklistVerdict(zen, '203.0.113.7', viaPublic, { missing: true })).toMatchObject({ state: 'unknown' });
    expect(blocklistVerdict(zen, '203.0.113.7', listedTest, { found: ['127.255.255.255'] })).toMatchObject({ state: 'unknown', said: matching(/asked too often/) });
  });

  it('says a lookup that failed could not be asked', () => {
    expect(blocklistVerdict(zen, '203.0.113.7', listedTest, { error: 'ESERVFAIL' })).toMatchObject({ state: 'unknown', said: 'Spamhaus ZEN could not be asked: ESERVFAIL' });
  });
});

describe('reverseDnsVerdict', () => {
  it('matches the mail host, with or without the final dot and in any case', () => {
    expect(reverseDnsVerdict('203.0.113.7', 'mail.example.dev', { found: ['Mail.Example.dev.'] })).toMatchObject({ state: 'matches' });
  });

  it('names what the address reverses to when it is not the mail host', () => {
    expect(reverseDnsVerdict('203.0.113.7', 'mail.example.dev', { found: ['vps-a1b2c3.vps.ovh.ca'] })).toMatchObject({ state: 'differs', said: '203.0.113.7 reverses to vps-a1b2c3.vps.ovh.ca, not mail.example.dev; set its PTR to mail.example.dev' });
    expect(reverseDnsVerdict('203.0.113.7', 'mail.example.dev', { missing: true })).toMatchObject({ state: 'none' });
    expect(reverseDnsVerdict('203.0.113.7', 'mail.example.dev', { error: 'ETIMEOUT' })).toMatchObject({ state: 'unknown' });
  });
});

describe('forwardVerdict', () => {
  it('checks the mail host points where it should', () => {
    expect(forwardVerdict('mail.example.dev', { found: ['203.0.113.7'] }, '203.0.113.7').state).toBe('matches');
    expect(forwardVerdict('mail.example.dev', { found: ['198.51.100.1'] }, '203.0.113.7')).toMatchObject({ state: 'differs', said: 'mail.example.dev points at 198.51.100.1, not 203.0.113.7' });
    expect(forwardVerdict('mail.example.dev', { missing: true }).state).toBe('none');
  });
});

describe('port25Verdict', () => {
  it('says how to send when port 25 is closed', () => {
    expect(port25Verdict({ ok: true })).toMatchObject({ open: true });
    expect(port25Verdict({ ok: false, error: 'ETIMEDOUT' })).toMatchObject({ open: false, said: matching(/MAIL_RELAYHOST=\[host\]:587/) });
    expect(port25Verdict({ ok: false, error: 'ETIMEDOUT' }, '[smtp.example.net]:587')).toMatchObject({ open: false, relay: '[smtp.example.net]:587' });
  });
});

const readiness = (overrides: Partial<MailReadiness> = {}): MailReadiness => ({
  domain: 'example.dev',
  host: 'mail.example.dev',
  ip: '203.0.113.7',
  checkedAt: '2026-10-30T00:00:00.000Z',
  forward: forwardVerdict('mail.example.dev', { found: ['203.0.113.7'] }),
  reverseDns: reverseDnsVerdict('203.0.113.7', 'mail.example.dev', { found: ['mail.example.dev.'] }),
  port25: port25Verdict({ ok: true }),
  blocklists: MAIL_BLOCKLISTS.map((list) => blocklistVerdict(list, '203.0.113.7', { found: ['127.0.0.2'] }, { missing: true })),
  ...overrides,
});

describe('mailProblems', () => {
  it('finds nothing wrong with a root ready to send', () => {
    expect(mailProblems(readiness())).toEqual([]);
    expect(mailUnknowns(readiness())).toEqual([]);
    expect(mailLines(readiness()).every((line) => line.mark === 'ok')).toBe(true);
  });

  it('lists a wrong PTR, a closed port and a listing, and keeps what could not be checked apart', () => {
    const bad = readiness({
      reverseDns: reverseDnsVerdict('203.0.113.7', 'mail.example.dev', { found: ['vps.ovh.ca'] }),
      port25: port25Verdict({ ok: false, error: 'ETIMEDOUT' }),
      blocklists: [
        blocklistVerdict(MAIL_BLOCKLISTS[0]!, '203.0.113.7', { found: ['127.255.255.254'] }, { found: ['127.255.255.254'] }),
        blocklistVerdict(MAIL_BLOCKLISTS[2]!, '203.0.113.7', { found: ['127.0.0.2'] }, { found: ['127.0.0.2'] }),
      ],
    });
    expect(mailProblems(bad)).toHaveLength(3);
    expect(mailUnknowns(bad)).toEqual([expect.stringMatching(/^Spamhaus ZEN could not be asked/)]);
    expect(mailLines(bad).map((line) => line.mark)).toEqual(['ok', 'problem', 'problem', 'unknown', 'problem']);
  });

  it('does not count a closed port 25 against a root that sends through a relay', () => {
    expect(mailProblems(readiness({ port25: port25Verdict({ ok: false, error: 'ETIMEDOUT' }, '[smtp.example.net]:587') }))).toEqual([]);
  });
});

describe('mailDomainFrom', () => {
  it('takes DOMAIN, else the domain root sends from', () => {
    expect(mailDomainFrom({ DOMAIN: 'Example.dev' })).toBe('example.dev');
    expect(mailDomainFrom({ MAIL_FROM: 'alerts@example.dev' })).toBe('example.dev');
    expect(mailDomainFrom({})).toBeUndefined();
  });
});

describe('mailCheckFrom', () => {
  it('reads the last marked line of mail-check.ts\'s output', () => {
    const output = `  ✓ something\n${MAIL_CHECK_MARK} ${JSON.stringify(readiness())}\n`;
    expect(mailCheckFrom(output)?.ip).toBe('203.0.113.7');
    expect(mailCheckFrom('no mark here')).toBeUndefined();
    expect(mailCheckFrom(`${MAIL_CHECK_MARK} {not json`)).toBeUndefined();
  });
});
