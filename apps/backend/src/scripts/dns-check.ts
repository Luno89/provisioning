import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { claimSettingsFrom, createDatabase, databaseSettingsFrom, loadKeys, operatorCredentialsFrom, operatorsAmong, roleFromEnv, type Database } from '../platform/index.js';
import { CredentialService, dnsProviderNamed, DnsProviders } from '../infrastructure/index.js';

export interface DnsCheckDeps {
  dns: Pick<DnsProviders, 'detect' | 'zone'>;
  db: Database;
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
}

const USAGE = 'usage: npm run dns:check -- <zone> [<zone> …] [--provider <name>] [--owner <operator id>]';

export async function dnsCheck(argv: readonly string[], deps: DnsCheckDeps): Promise<boolean> {
  const arg = (name: string): string | undefined => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const zones = argv.filter((value, index, all) => !value.startsWith('--') && !all[index - 1]?.startsWith('--'));
  if (zones.length === 0) throw new Error(`${USAGE}\nFinds who serves each zone's DNS and lists its records with your stored credentials. It changes nothing.`);
  const role = roleFromEnv(deps.env);
  const owner = arg('owner') ?? operatorsAmong(await deps.db.accounts.getUsers(), claimSettingsFrom(role))[0]?.id;
  if (!owner) throw new Error('no operator on this box; pass --owner <id>');
  const credentials = new CredentialService(deps.db, loadKeys(deps.env).data, { claims: claimSettingsFrom(role), credentials: operatorCredentialsFrom(deps.env) });
  let failed = false;
  for (const zone of zones) {
    const detected = await deps.dns.detect(zone);
    const provider = arg('provider') ?? detected.provider;
    deps.log(`${zone}: nameservers ${detected.nameservers.join(', ') || 'none'}`);
    if (!provider) {
      deps.log(`  ✗ ${detected.problem}`);
      failed = true;
      continue;
    }
    const described = dnsProviderNamed(provider);
    const fields = await credentials.dnsCredentialsOf(owner, provider);
    if (!fields) {
      deps.log(`  ✗ served by ${described.label}, and no ${described.label} credentials are stored under Cloud providers. ${described.setup}`);
      failed = true;
      continue;
    }
    try {
      const records = await (await deps.dns.zone(provider, fields, zone)).all();
      deps.log(`  ✓ served by ${described.label}; ${records.length} record${records.length === 1 ? '' : 's'}:`);
      for (const record of [...records].sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type))) deps.log(`    ${record.type.padEnd(5)} ${record.name}  ${record.content}`);
    } catch (error) {
      deps.log(`  ✗ ${(error as Error).message}`);
      failed = true;
    }
  }
  return !failed;
}

async function main(): Promise<void> {
  dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });
  const db = createDatabase(databaseSettingsFrom(process.env));
  await db.init();
  try {
    if (!(await dnsCheck(process.argv.slice(2), { dns: new DnsProviders(), db, env: process.env, log: (line) => console.log(line) }))) process.exitCode = 1;
  } finally {
    await db.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: Error) => {
    console.error(`dns:check — ${error.message}`);
    process.exit(1);
  });
}
