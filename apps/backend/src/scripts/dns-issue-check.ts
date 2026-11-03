import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { claimSettingsFrom, createDatabase, loadKeys, operatorsAmong, roleFromEnv, type Database } from '../platform/index.js';
import {
  buildCaddyImage, caddyDnsEnv, caddyEnvLines, certificateProblems, challengeLeftovers, challengeNameIn, checkWildcardIn, credentialEnvOf,
  CredentialService, dnsProviderNamed, DnsProviders, issueCheckCaddyfile, issueCheckTlsSnippet, issueWithCaddy, secretValuesIn, STAGING_CA,
  zoneChanges,
} from '../infrastructure/index.js';

const CADDY_IMAGE = 'nowrinkles/caddy:2.10.2';
const CADDY_CONTEXT = fileURLToPath(new URL('../../../../docker/caddy', import.meta.url));

const describeRecord = (record: { type: string; name: string }): string => `${record.type} ${record.name}`;

export interface DnsIssueCheckDeps {
  dns: Pick<DnsProviders, 'detect' | 'zone'>;
  db: Database;
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  build: (image: string, context: string) => Promise<void>;
  issue: typeof issueWithCaddy;
}

export async function dnsIssueCheck(argv: readonly string[], deps: DnsIssueCheckDeps): Promise<boolean> {
  const arg = (name: string): string | undefined => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const zones = argv.filter((value, index, all) => !value.startsWith('--') && !all[index - 1]?.startsWith('--'));
  if (zones.length === 0) {
    throw new Error([
      'usage: npm run dns:issue-check -- <zone> [<zone> …] [--owner <operator id>]',
      'Proves a wildcard certificate for *.koala-check.<zone> is issued over DNS-01 with your stored DNS credentials,',
      `through root's own Caddy and its tls snippet, from Let's Encrypt's staging service only (${STAGING_CA}).`,
      'The only records it touches are the temporary TXT _acme-challenge.koala-check.<zone>; nothing is served.',
    ].join('\n'));
  }
  const { dns, db, log } = deps;
  let failed = false;
  const role = roleFromEnv(deps.env);
  const owner = arg('owner') ?? operatorsAmong(await db.accounts.getUsers(), claimSettingsFrom(role))[0]?.id;
  if (!owner) throw new Error('no operator on this box; pass --owner <id>');
  const credentials = new CredentialService(db, loadKeys(deps.env).data, claimSettingsFrom(role));
  log(`Building Koala's Caddy (${CADDY_IMAGE}) from docker/caddy, with every pinned DNS module…`);
  await deps.build(CADDY_IMAGE, CADDY_CONTEXT);

  for (const zone of zones) {
    const wildcard = checkWildcardIn(zone);
    log(`\n${zone} → ${wildcard}`);
    const detected = await dns.detect(zone);
    if (!detected.provider) {
      log(`  ✗ ${detected.problem}`);
      failed = true;
      continue;
    }
    const described = dnsProviderNamed(detected.provider);
    log(`  provider: ${described.label} (nameservers ${detected.nameservers.join(', ')})`);
    const fields = await credentials.dnsCredentialsOf(owner, described.name);
    const env = credentialEnvOf(described, fields);
    if (!fields || !env) {
      log(`  ✗ no ${described.label} credentials are stored under Cloud providers. ${described.setup}`);
      failed = true;
      continue;
    }
    try {
      const records = await dns.zone(described.name, fields, zone);
      const stale = challengeLeftovers(await records.all(), zone);
      for (const record of stale) await records.remove(record);
      if (stale.length) log(`  removed ${stale.length} TXT ${challengeNameIn(zone)} left by an earlier check`);
      const before = await records.all();

      const envLines = caddyEnvLines(caddyDnsEnv(described, env));
      const secrets = secretValuesIn(envLines);
      log(`  asking Let's Encrypt staging through Caddy over ${described.label}…`);
      const result = await deps.issue({
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
          log(`  ✗ issued, but the certificate is not what was asked: ${problems.join('; ')}`);
          failed = true;
        } else {
          log('  ✓ issued');
        }
        log(`    names:   ${result.certificate.names.join(', ')}`);
        log(`    issuer:  ${result.certificate.issuer}`);
        log(`    valid:   ${result.certificate.validFrom.toISOString()} → ${result.certificate.validTo.toISOString()}`);
        log(`    through: ${result.issuer ?? 'Caddy did not say'}`);
      } else {
        log(`  ✗ not issued: ${result.why ?? 'Caddy did not say why'}`);
        failed = true;
      }
      for (const error of result.cleanupErrors) log(`  ! Caddy could not remove its challenge record: ${error}`);
      if (left.length) {
        log(`  ✗ TXT ${challengeNameIn(zone)} is still in the zone after removing it (${left.length})`);
        failed = true;
      } else if (leftCount) {
        log(`  ! Caddy left ${leftCount} TXT ${challengeNameIn(zone)}; removed it, the zone's API now lists none`);
      } else {
        log(`  ✓ TXT cleaned up: ${described.label}'s API lists no ${challengeNameIn(zone)}`);
      }
      if (changes.added.length || changes.removed.length) {
        log(`  ✗ the zone changed: added ${changes.added.map(describeRecord).join(', ') || 'nothing'}; removed ${changes.removed.map(describeRecord).join(', ') || 'nothing'}`);
        failed = true;
      } else {
        log(`  ✓ the zone's ${before.length} records are as they were`);
      }
      log(result.logNamedSecret ? '  ✗ Caddy\'s log named a credential (not shown)' : '  ✓ Caddy\'s log named no credential');
      if (result.logNamedSecret) failed = true;
    } catch (error) {
      log(`  ✗ ${(error as Error).message}`);
      failed = true;
    }
  }
  return !failed;
}

async function main(): Promise<void> {
  dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });
  const db = createDatabase();
  await db.init();
  try {
    const passed = await dnsIssueCheck(process.argv.slice(2), { dns: new DnsProviders(), db, env: process.env, log: (line) => console.log(line), build: buildCaddyImage, issue: issueWithCaddy });
    if (!passed) process.exitCode = 1;
  } finally {
    await db.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: Error) => {
    console.error(`dns:issue-check — ${error.message}`);
    process.exit(1);
  });
}
