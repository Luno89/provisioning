import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { claimSettingsFrom, createDatabase, loadKeys, operatorsAmong, roleFromEnv } from '../platform/index.js';
import { CredentialService, dnsProviderNamed, DnsProviders } from '../infrastructure/index.js';

dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
};

async function main(): Promise<void> {
  const zones = process.argv.slice(2).filter((value, index, all) => !value.startsWith('--') && !all[index - 1]?.startsWith('--'));
  if (zones.length === 0) {
    console.error('usage: npm run dns:check -- <zone> [<zone> …] [--provider <name>] [--owner <operator id>]');
    console.error('Finds who serves each zone\'s DNS and lists its records with your stored credentials. It changes nothing.');
    process.exit(2);
  }
  const dns = new DnsProviders();
  const db = createDatabase();
  await db.init();
  try {
    const role = roleFromEnv(process.env);
    const owner = arg('owner') ?? operatorsAmong(await db.accounts.getUsers(), claimSettingsFrom(role))[0]?.id;
    if (!owner) throw new Error('no operator on this box; pass --owner <id>');
    const credentials = new CredentialService(db, loadKeys(process.env).data, claimSettingsFrom(role));
    let failed = false;
    for (const zone of zones) {
      const detected = await dns.detect(zone);
      const provider = arg('provider') ?? detected.provider;
      console.log(`${zone}: nameservers ${detected.nameservers.join(', ') || 'none'}`);
      if (!provider) {
        console.log(`  ✗ ${detected.problem}`);
        failed = true;
        continue;
      }
      const described = dnsProviderNamed(provider);
      const fields = await credentials.dnsCredentialsOf(owner, provider);
      if (!fields) {
        console.log(`  ✗ served by ${described.label}, and no ${described.label} credentials are stored under Cloud providers. ${described.setup}`);
        failed = true;
        continue;
      }
      try {
        const records = await (await dns.zone(provider, fields, zone)).all();
        console.log(`  ✓ served by ${described.label}; ${records.length} record${records.length === 1 ? '' : 's'}:`);
        for (const record of [...records].sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type))) console.log(`    ${record.type.padEnd(5)} ${record.name}  ${record.content}`);
      } catch (error) {
        console.log(`  ✗ ${(error as Error).message}`);
        failed = true;
      }
    }
    if (failed) process.exitCode = 1;
  } finally {
    await db.close();
  }
}

main().catch((error: Error) => {
  console.error(`dns:check — ${error.message}`);
  process.exit(1);
});
