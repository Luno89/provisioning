import { describe, expect, it } from 'vitest';
import { ALWAYS_OPEN, certificateProblem, headerProblems, mailRecordProblems, portProblems, portsToScan, portSummary, summary, unknownName } from './root-smoke.js';

const now = new Date('2026-10-29T00:00:00Z');
const days = (n: number) => new Date(now.getTime() + n * 24 * 60 * 60 * 1000);

describe('the certificate', () => {
  it('passes a trusted one with more than two weeks left', () => {
    expect(certificateProblem(days(60), true, undefined, now)).toBeUndefined();
  });

  it('names an untrusted one, one about to expire, and one expired', () => {
    expect(certificateProblem(days(60), false, 'SELF_SIGNED_CERT_IN_CHAIN', now)).toMatch(/not trusted: SELF_SIGNED/);
    expect(certificateProblem(days(5), true, undefined, now)).toMatch(/expires in 5 days/);
    expect(certificateProblem(days(-2), true, undefined, now)).toMatch(/expired 2 days ago/);
  });
});

describe('the security headers', () => {
  const good = { 'Content-Security-Policy': "default-src 'self'", 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains', 'X-Content-Type-Options': 'nosniff' };

  it('passes the policy, a long HSTS and nosniff, whatever their case', () => {
    expect(headerProblems(good)).toEqual([]);
  });

  it('names each one missing or weak', () => {
    expect(headerProblems({})).toEqual(['no Content-Security-Policy', 'no Strict-Transport-Security', 'X-Content-Type-Options is not nosniff']);
    expect(headerProblems({ ...good, 'Strict-Transport-Security': 'max-age=600' })).toEqual(['Strict-Transport-Security is short: max-age=600']);
  });
});

describe('the mail records', () => {
  const seen = {
    domain: 'nowrinkles.dev',
    ip: '203.0.113.7',
    mailHostA: ['203.0.113.7'],
    domainTxt: [['v=spf1 ip4:203.0.113.7 ~all'], ['google-site-verification=abc']],
    dkimTxt: [['v=DKIM1; k=rsa; p=', 'A'.repeat(200)]],
    dmarcTxt: [['v=DMARC1; p=none']],
  };

  it('passes what mail-dns.ts publishes, a DKIM key split across strings included', () => {
    expect(mailRecordProblems(seen)).toEqual([]);
  });

  it('names each record that is missing or points elsewhere', () => {
    expect(mailRecordProblems({ ...seen, mailHostA: ['198.51.100.1'], domainTxt: [['v=spf1 include:_spf.example.com ~all']], dkimTxt: [], dmarcTxt: [] })).toEqual([
      'mail.nowrinkles.dev resolves to 198.51.100.1, not root\'s 203.0.113.7',
      'nowrinkles.dev\'s SPF (v=spf1 include:_spf.example.com ~all) does not name ip4:203.0.113.7',
      'koala._domainkey.nowrinkles.dev has no DKIM key',
      '_dmarc.nowrinkles.dev has no DMARC record',
    ]);
  });
});

describe('the ports open from outside', () => {
  it('allows only HTTP and HTTPS, and SSH only when it is public', () => {
    expect(portProblems([...ALWAYS_OPEN], false)).toEqual([]);
    expect(portProblems([22, 80, 443], true)).toEqual([]);
    expect(portProblems([22, 80, 443, 27017], false)).toEqual(['port 22 answers from outside', 'port 27017 answers from outside']);
  });

  it('names HTTP or HTTPS not answering', () => {
    expect(portProblems([443], false)).toEqual(['port 80 does not answer']);
  });
});

describe('the report', () => {
  it('makes a name under the people domain no instance can hold', () => {
    expect(unknownName('nowrinkles.app', 'A1-b2_C3')).toBe('smokea1b2c3.nowrinkles.app');
  });

  it('counts what failed and shows what each check found', () => {
    expect(summary([{ check: 'tls', found: '60 days left' }, { check: 'ports', found: '80, 443', problem: 'port 22 answers from outside' }])).toEqual({
      lines: ['✓ tls: 60 days left', '✗ ports: port 22 answers from outside'],
      failed: 1,
    });
  });
});

describe('the ports scanned', () => {
  it('covers every port Kubernetes hands out as a NodePort, besides the common ones', () => {
    const ports = portsToScan();
    expect(ports).toContain(30000);
    expect(ports).toContain(31737);
    expect(ports).toContain(32767);
    expect(ports).toContain(27017);
    expect(ports).not.toContain(32768);
    expect(new Set(ports).size).toBe(ports.length);
  });

  it('says how many node ports answered', () => {
    expect(portSummary([80, 443], 2800, '203.0.113.7')).toBe('203.0.113.7: of 2800 ports (30000–32767, every port Kubernetes gives a NodePort, among them), 80, 443 answer');
    expect(portSummary([80, 443, 31737], 2800, '203.0.113.7')).toMatch(/80, 443, 31737 answer, 1 of them node ports$/);
    expect(portProblems([80, 443, 31737], false)).toEqual(['port 31737 answers from outside']);
  });
});
