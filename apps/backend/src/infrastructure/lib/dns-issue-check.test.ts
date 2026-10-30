import { describe, expect, it } from 'vitest';
import {
  caddyEnvLines, caddyEvent, certificatePathIn, certificateProblems, challengeLeftovers, issueCheckCaddyfile, issueCheckTlsSnippet,
  namesFromSubjectAltName, secretValuesIn, STAGING_CA, stagingOnlyProblem, withoutSecrets, zoneChanges,
} from './dns-issue-check.js';
import { caddyDnsEnv, caddyTlsSnippet, CLOUDFLARE_DNS, PORKBUN_DNS } from './dns-providers.js';

describe('the Caddyfile the issuance check runs', () => {
  it('serves only the check\'s wildcard under the zone, through root\'s own tls snippet', () => {
    const caddyfile = issueCheckCaddyfile('nowrinkles.app');
    expect(caddyfile).toContain('*.koala-check.nowrinkles.app {\n\timport koala_tls\n');
    expect(caddyfile).toContain('(koala_tls) {\n\timport /etc/caddy/tls/koala.caddy\n}');
    expect(caddyfile.split('\n').filter((line) => /^\S/.test(line) && line.endsWith('{'))).toEqual(['{', '(koala_tls) {', '*.koala-check.nowrinkles.app {']);
    expect(caddyfile).toContain('storage file_system /data');
  });

  it('always asks Let\'s Encrypt\'s staging service and never its production one', () => {
    for (const zone of ['nowrinkles.app', 'nowrinkles.dev', 'example.org.']) {
      const caddyfile = issueCheckCaddyfile(zone);
      expect(caddyfile).toContain(`acme_ca ${STAGING_CA}`);
      expect(caddyfile).not.toMatch(/acme-v02\.api\.letsencrypt\.org/);
    }
    expect(STAGING_CA).toBe('https://acme-staging-v02.api.letsencrypt.org/directory');
  });

  it('uses the tls snippet root writes for the provider, unchanged', () => {
    expect(issueCheckTlsSnippet(PORKBUN_DNS)).toBe(caddyTlsSnippet('acme', PORKBUN_DNS));
    expect(issueCheckTlsSnippet(CLOUDFLARE_DNS)).toBe(caddyTlsSnippet('acme', CLOUDFLARE_DNS));
  });
});

describe('refusing a configuration that could reach anything but staging', () => {
  const staging = { module: 'acme', ca: STAGING_CA };
  const adapted = (policies: unknown[]) => ({ apps: { tls: { automation: { policies } } } }) as Parameters<typeof stagingOnlyProblem>[0];

  it('passes when every policy asks only staging', () => {
    expect(stagingOnlyProblem(adapted([{ subjects: ['*.koala-check.nowrinkles.app'], issuers: [staging] }, { issuers: [staging] }]), 'nowrinkles.app')).toBeUndefined();
  });

  it('refuses a production issuer, a policy with no issuer and a missing policy', () => {
    expect(stagingOnlyProblem(adapted([{ subjects: ['*.koala-check.nowrinkles.app'], issuers: [{ module: 'acme', ca: 'https://acme-v02.api.letsencrypt.org/directory' }] }]), 'nowrinkles.app')).toMatch(/not Let's Encrypt's staging/);
    expect(stagingOnlyProblem(adapted([{ subjects: ['*.koala-check.nowrinkles.app'], issuers: [staging] }, {}]), 'nowrinkles.app')).toMatch(/names no issuer/);
    expect(stagingOnlyProblem(adapted([{ subjects: ['*.koala-check.nowrinkles.app'], issuers: [staging, { module: 'zerossl' }] }]), 'nowrinkles.app')).toMatch(/zerossl/);
    expect(stagingOnlyProblem(adapted([{ issuers: [staging] }]), 'nowrinkles.app')).toMatch(/no certificate policy/);
  });
});

describe('reading Caddy\'s log', () => {
  const line = (entry: Record<string, unknown>) => JSON.stringify(entry);

  it('hears the certificate obtained for the check\'s wildcard, and from which issuer', () => {
    expect(caddyEvent(line({ level: 'info', logger: 'tls.obtain', msg: 'certificate obtained successfully', identifier: '*.koala-check.nowrinkles.dev', issuer: 'acme-staging-v02.api.letsencrypt.org-directory' }), 'nowrinkles.dev'))
      .toEqual({ kind: 'obtained', issuer: 'acme-staging-v02.api.letsencrypt.org-directory' });
  });

  it('hears a failed attempt with its error, and a challenge record Caddy could not remove', () => {
    expect(caddyEvent(line({ level: 'error', logger: 'tls.obtain', msg: 'could not get certificate from issuer', identifier: '*.koala-check.nowrinkles.app', error: 'presenting for challenge: refused' }), 'nowrinkles.app'))
      .toEqual({ kind: 'attempt-failed', error: 'presenting for challenge: refused' });
    expect(caddyEvent(line({ level: 'error', logger: 'tls.issuance.acme.acme_client', msg: 'cleaning up solver', error: 'no such record' }), 'nowrinkles.app'))
      .toEqual({ kind: 'cleanup-failed', error: 'no such record' });
  });

  it('ignores another name, an ordinary line and what is not JSON', () => {
    expect(caddyEvent(line({ msg: 'certificate obtained successfully', identifier: 'app.nowrinkles.dev' }), 'nowrinkles.dev')).toBeUndefined();
    expect(caddyEvent(line({ level: 'info', logger: 'http', msg: 'server running' }), 'nowrinkles.dev')).toBeUndefined();
    expect(caddyEvent('Caddy 2.10.2', 'nowrinkles.dev')).toBeUndefined();
  });
});

describe('the certificate it reads back', () => {
  const now = new Date('2026-10-30T12:00:00Z');
  const good = { names: ['*.koala-check.nowrinkles.app'], issuer: 'C=US, O=(STAGING) Let\'s Encrypt, CN=(STAGING) Ersatz Edamame E1', validFrom: new Date('2026-10-30T11:00:00Z'), validTo: new Date('2027-01-28T11:00:00Z') };

  it('is found where Caddy keeps the staging issuer\'s certificates', () => {
    expect(certificatePathIn('nowrinkles.app')).toBe('certificates/acme-staging-v02.api.letsencrypt.org-directory/wildcard_.koala-check.nowrinkles.app/wildcard_.koala-check.nowrinkles.app.crt');
  });

  it('passes only for the wildcard alone, from staging, still valid', () => {
    expect(certificateProblems(good, 'nowrinkles.app', now)).toEqual([]);
    expect(certificateProblems({ ...good, names: ['*.koala-check.nowrinkles.app', 'nowrinkles.app'] }, 'nowrinkles.app', now)).toHaveLength(1);
    expect(certificateProblems({ ...good, issuer: 'C=US, O=Let\'s Encrypt, CN=E7' }, 'nowrinkles.app', now)[0]).toMatch(/not Let's Encrypt's staging/);
    expect(certificateProblems({ ...good, validTo: new Date('2026-10-01T00:00:00Z') }, 'nowrinkles.app', now)[0]).toMatch(/expired/);
  });

  it('reads the DNS names from a subject alternative name', () => {
    expect(namesFromSubjectAltName('DNS:*.koala-check.nowrinkles.app, IP Address:127.0.0.1')).toEqual(['*.koala-check.nowrinkles.app']);
    expect(namesFromSubjectAltName(undefined)).toEqual([]);
  });
});

describe('cleaning up after it', () => {
  const records = [
    { id: '1', type: 'TXT' as const, name: '_acme-challenge.koala-check.nowrinkles.app', content: 'token' },
    { id: '2', type: 'TXT' as const, name: '_acme-challenge.KOALA-CHECK.nowrinkles.app.', content: 'token' },
    { id: '3', type: 'TXT' as const, name: '_acme-challenge.nowrinkles.app', content: 'someone else' },
    { id: '4', type: 'TXT' as const, name: '_acme-challenge.app.koala-check.nowrinkles.app', content: 'deeper' },
    { id: '5', type: 'CNAME' as const, name: '_acme-challenge.koala-check.nowrinkles.app', content: 'elsewhere' },
    { id: '6', type: 'TXT' as const, name: 'koala-check.nowrinkles.app', content: 'the name itself' },
    { type: 'TXT' as const, name: '_acme-challenge.koala-check.nowrinkles.app', content: 'no id' },
  ];

  it('removes only TXT _acme-challenge.koala-check.<zone>, nothing else in the zone', () => {
    expect(challengeLeftovers(records, 'nowrinkles.app').map((record) => record.id)).toEqual(['1', '2']);
    expect(challengeLeftovers(records, 'nowrinkles.dev')).toEqual([]);
  });

  it('says what changed in a zone between two readings', () => {
    const before = [{ type: 'A' as const, name: 'app.nowrinkles.dev', content: '1.2.3.4' }];
    expect(zoneChanges(before, before)).toEqual({ added: [], removed: [] });
    expect(zoneChanges(before, [{ type: 'A' as const, name: 'app.nowrinkles.dev', content: '5.6.7.8' }]).removed).toEqual(before);
  });
});

describe('handing Caddy its credentials', () => {
  it('passes exactly the lines root\'s Caddy gets, and hides their values in anything shown', () => {
    const envFile = caddyDnsEnv(PORKBUN_DNS, { PORKBUN_API_KEY: 'pk1_abc', PORKBUN_API_SECRET_KEY: 'sk1_def' });
    const lines = caddyEnvLines(envFile);
    expect(lines).toEqual(['PORKBUN_API_KEY=pk1_abc', 'PORKBUN_API_SECRET_KEY=sk1_def']);
    expect(secretValuesIn(lines)).toEqual(['pk1_abc', 'sk1_def']);
    expect(withoutSecrets('refused pk1_abc and sk1_def', secretValuesIn(lines))).toBe('refused [hidden] and [hidden]');
  });
});
