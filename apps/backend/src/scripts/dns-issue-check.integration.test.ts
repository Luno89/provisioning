import { testIdentityKey, testKeyEnv } from '../platform/testing/keys.js';
import { describe, expect, it } from 'vitest';
import { challengeNameIn, checkWildcardIn, CredentialService, DnsProviders } from '../infrastructure/index.js';
import { fakePorkbun } from '../infrastructure/services/dns/fake-dns.js';
import { loadKeys } from '../platform/lib/keys.js';
import { testDatabase } from '../platform/lib/test-database.js';
import type { UserMetadata } from '../platform/lib/types.js';
import { dnsIssueCheck } from './dns-issue-check.js';

const env = { ROLE: 'root', ...testKeyEnv('dns-issue-check'), ROOT_IDENTITY_KEY: testIdentityKey() };
const ZONE = 'koala.test';

describe('npm run dns:issue-check', () => {
  it('has a staging certificate issued over the zone\'s provider, removes every challenge it finds, and checks the rest of the zone is as it was', async () => {
    const db = await testDatabase();
    await db.accounts.saveUser({ id: 'op', email: 'op@example.com', roles: ['operator'], createdAt: 't', twoFactorEnabled: false, emailVerified: true } as UserMetadata);
    const fake = fakePorkbun([ZONE]);
    await new CredentialService(db, loadKeys(env).data).saveCredentials('op', 'porkbun' as never, fake.good);
    const dns = new DnsProviders(fake.fetch, async () => ['curitiba.ns.porkbun.com']);
    const zone = await dns.zone('porkbun', fake.good, ZONE);
    await zone.create({ type: 'A', name: `app.${ZONE}`, content: '203.0.113.7' });
    await zone.create({ type: 'TXT', name: challengeNameIn(ZONE), content: 'left by an earlier check' });

    const built: string[] = [];
    const said: string[] = [];
    const passed = await dnsIssueCheck([ZONE], {
      dns, db, env, log: (line) => said.push(line),
      build: async (image) => { built.push(image); },
      issue: async (request) => {
        await zone.create({ type: 'TXT', name: challengeNameIn(request.zone), content: 'token-from-caddy' });
        return {
          obtained: true, issuer: 'acme-staging-v02', cleanupErrors: [], logNamedSecret: false,
          certificate: { names: [checkWildcardIn(request.zone)], issuer: '(STAGING) Pretend Pear R3', validFrom: new Date(Date.now() - 60_000), validTo: new Date(Date.now() + 86_400_000) },
        };
      },
    });

    expect(passed).toBe(true);
    expect(built).toHaveLength(1);
    expect(said).toEqual(expect.arrayContaining([
      `  removed 1 TXT ${challengeNameIn(ZONE)} left by an earlier check`,
      '  ✓ issued',
      `  ! Caddy left 1 TXT ${challengeNameIn(ZONE)}; removed it, the zone's API now lists none`,
      '  ✓ the zone\'s 1 records are as they were',
      '  ✓ Caddy\'s log named no credential',
    ]));
    expect((await zone.all()).map((record) => `${record.type} ${record.name}`)).toEqual([`A app.${ZONE}`]);
  });

  it('fails a zone whose certificate is not the one asked for, and refuses to run with no zone', async () => {
    const db = await testDatabase();
    await db.accounts.saveUser({ id: 'op', email: 'op@example.com', roles: ['operator'], createdAt: 't', twoFactorEnabled: false, emailVerified: true } as UserMetadata);
    const fake = fakePorkbun([ZONE]);
    await new CredentialService(db, loadKeys(env).data).saveCredentials('op', 'porkbun' as never, fake.good);
    const dns = new DnsProviders(fake.fetch, async () => ['curitiba.ns.porkbun.com']);
    const said: string[] = [];
    const passed = await dnsIssueCheck([ZONE], {
      dns, db, env, log: (line) => said.push(line), build: async () => undefined,
      issue: async () => ({ obtained: true, cleanupErrors: [], logNamedSecret: false, certificate: { names: ['koala.test'], issuer: 'Real CA', validFrom: new Date(), validTo: new Date(Date.now() + 86_400_000) } }),
    });
    expect(passed).toBe(false);
    expect(said.find((line) => line.includes('✗ issued, but'))).toMatch(/names koala\.test.*not Let's Encrypt's staging service/);
    await expect(dnsIssueCheck([], { dns, db, env, log: () => undefined, build: async () => undefined, issue: async () => ({ obtained: false, cleanupErrors: [], logNamedSecret: false }) })).rejects.toThrow(/usage: npm run dns:issue-check/);
  });
});
