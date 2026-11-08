import { describe, expect, it } from 'vitest';
import { CredentialService, DnsProviders } from '../infrastructure/index.js';
import { fakePorkbun } from '../infrastructure/services/dns/fake-dns.js';
import { loadKeys } from '../platform/lib/keys.js';
import { testDatabase } from '../platform/lib/test-database.js';
import type { UserMetadata } from '../platform/lib/types.js';
import { dnsCheck } from './dns-check.js';

const env = { ROLE: 'root', JWT_SECRET: 'dns-check-test-secret-0123456789abcdef' };

describe('npm run dns:check', () => {
  it('lists each zone\'s records with the operator\'s stored credentials, and fails for a zone it cannot read', async () => {
    const db = await testDatabase();
    await db.accounts.saveUser({ id: 'op', email: 'op@example.com', roles: ['operator'], createdAt: 't', twoFactorEnabled: false, emailVerified: true } as UserMetadata);
    const fake = fakePorkbun(['koala.test']);
    await new CredentialService(db, loadKeys(env).data).saveCredentials('op', 'porkbun' as never, fake.good);
    const dns = new DnsProviders(fake.fetch, async (zone) => (zone === 'koala.test' ? ['curitiba.ns.porkbun.com'] : ['ns1.example.net']));
    await (await dns.zone('porkbun', fake.good, 'koala.test')).create({ type: 'A', name: 'app.koala.test', content: '203.0.113.7' });

    const said: string[] = [];
    expect(await dnsCheck(['koala.test', 'other.test'], { dns, db, env, log: (line) => said.push(line) })).toBe(false);
    expect(said.slice(0, 3)).toEqual(['koala.test: nameservers curitiba.ns.porkbun.com', '  ✓ served by Porkbun DNS; 1 record:', '    A     app.koala.test  203.0.113.7']);
    expect(said[3]).toBe('other.test: nameservers ns1.example.net');
    expect(said[4]).toMatch(/^ {2}✗ /);
    await expect(dnsCheck([], { dns, db, env, log: () => undefined })).rejects.toThrow(/usage: npm run dns:check/);
  });
});
