import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { claimSettingsFrom, createDatabase, loadKeys, operatorsAmong, roleFromEnv } from '../platform/index.js';
import {
  buildCaddyImage, caddyDnsEnv, caddyEnvLines, certificateProblems, challengeLeftovers, challengeNameIn, checkWildcardIn, credentialEnvOf,
  CredentialService, dnsProviderNamed, DnsProviders, issueCheckCaddyfile, issueCheckTlsSnippet, issueWithCaddy, secretValuesIn, STAGING_CA,
  zoneChanges,
} from '../infrastructure/index.js';

dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });

const CADDY_IMAGE = 'nowrinkles/caddy:2.10.2';
const CADDY_CONTEXT = fileURLToPath(new URL('../../../../docker/caddy', import.meta.url));

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
};

const describeRecord = (record: { type: string; name: string }): string => `${record.type} ${record.name}`;

async function main(): Promise<void> {
  const zones = process.argv.slice(2).filter((value, index, all) => !value.startsWith('--') && !all[index - 1]?.startsWith('--'));
  if (zones.length === 0) {
    console.error('usage: npm run dns:issue-check -- <zone> [<zone> …] [--owner <operator id>]');
    console.error(`Proves a wildcard certificate for *.koala-check.<zone> is issued over DNS-01 with your stored DNS credentials,`);
    console.error(`through root's own Caddy and its tls snippet, from Let's Encrypt's staging service only (${STAGING_CA}).`);
    console.error('The only records it touches are the temporary TXT _acme-challenge.koala-check.<zone>; nothing is served.');
    process.exit(2);
  }
  const dns = new DnsProviders();
  const db = createDatabase();
  await db.init();
  let failed = false;
  try {
    const role = roleFromEnv(process.env);
    const owner = arg('owner') ?? operatorsAmong(await db.accounts.getUsers(), claimSettingsFrom(role))[0]?.id;
    if (!owner) throw new Error('no operator on this box; pass --owner <id>');
    const credentials = new CredentialService(db, loadKeys(process.env).data, claimSettingsFrom(role));
    console.log(`Building Koala's Caddy (${CADDY_IMAGE}) from docker/caddy, with every pinned DNS module…`);
    await buildCaddyImage(CADDY_IMAGE, CADDY_CONTEXT);

    for (const zone of zones) {
      const wildcard = checkWildcardIn(zone);
      console.log(`\n${zone} → ${wildcard}`);
      const detected = await dns.detect(zone);
      if (!detected.provider) {
        console.log(`  ✗ ${detected.problem}`);
        failed = true;
        continue;
      }
      const described = dnsProviderNamed(detected.provider);
      console.log(`  provider: ${described.label} (nameservers ${detected.nameservers.join(', ')})`);
      const fields = await credentials.dnsCredentialsOf(owner, described.name);
      const env = credentialEnvOf(described, fields);
      if (!fields || !env) {
        console.log(`  ✗ no ${described.label} credentials are stored under Cloud providers. ${described.setup}`);
        failed = true;
        continue;
      }
      try {
        const records = await dns.zone(described.name, fields, zone);
        const stale = challengeLeftovers(await records.all(), zone);
        for (const record of stale) await records.remove(record);
        if (stale.length) console.log(`  removed ${stale.length} TXT ${challengeNameIn(zone)} left by an earlier check`);
        const before = await records.all();

        const envLines = caddyEnvLines(caddyDnsEnv(described, env));
        const secrets = secretValuesIn(envLines);
        console.log(`  asking Let's Encrypt staging through Caddy over ${described.label}…`);
        const result = await issueWithCaddy({
          image: CADDY_IMAGE, zone, caddyfile: issueCheckCaddyfile(zone), tlsSnippet: issueCheckTlsSnippet(described), envLines, secrets,
        });

        let left = challengeLeftovers(await records.all(), zone);
        const leftCount = left.length;
        for (const record of left) await records.remove(record);
        left = challengeLeftovers(await records.all(), zone);
        const changes = zoneChanges(before, await records.all());

        if (result.obtained && result.certificate) {
          const problems = certificateProblems(result.certificate, zone, new Date());
          if (problems.length) {
            console.log(`  ✗ issued, but the certificate is not what was asked: ${problems.join('; ')}`);
            failed = true;
          } else {
            console.log('  ✓ issued');
          }
          console.log(`    names:   ${result.certificate.names.join(', ')}`);
          console.log(`    issuer:  ${result.certificate.issuer}`);
          console.log(`    valid:   ${result.certificate.validFrom.toISOString()} → ${result.certificate.validTo.toISOString()}`);
          console.log(`    through: ${result.issuer ?? 'Caddy did not say'}`);
        } else {
          console.log(`  ✗ not issued: ${result.why ?? 'Caddy did not say why'}`);
          failed = true;
        }
        for (const error of result.cleanupErrors) console.log(`  ! Caddy could not remove its challenge record: ${error}`);
        if (left.length) {
          console.log(`  ✗ TXT ${challengeNameIn(zone)} is still in the zone after removing it (${left.length})`);
          failed = true;
        } else if (leftCount) {
          console.log(`  ! Caddy left ${leftCount} TXT ${challengeNameIn(zone)}; removed it, the zone's API now lists none`);
        } else {
          console.log(`  ✓ TXT cleaned up: ${described.label}'s API lists no ${challengeNameIn(zone)}`);
        }
        if (changes.added.length || changes.removed.length) {
          console.log(`  ✗ the zone changed: added ${changes.added.map(describeRecord).join(', ') || 'nothing'}; removed ${changes.removed.map(describeRecord).join(', ') || 'nothing'}`);
          failed = true;
        } else {
          console.log(`  ✓ the zone's ${before.length} records are as they were`);
        }
        console.log(result.logNamedSecret ? '  ✗ Caddy\'s log named a credential (not shown)' : '  ✓ Caddy\'s log named no credential');
        if (result.logNamedSecret) failed = true;
      } catch (error) {
        console.log(`  ✗ ${(error as Error).message}`);
        failed = true;
      }
    }
  } finally {
    await db.close();
  }
  if (failed) process.exitCode = 1;
}

main().catch((error: Error) => {
  console.error(`dns:issue-check — ${error.message}`);
  process.exit(1);
});
