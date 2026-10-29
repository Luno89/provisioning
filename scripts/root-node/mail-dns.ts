import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { credentialsFromEnv, dkimValue, dnsProviderNamed, DnsProviders, mailByHand, mailRecords } from '../../apps/backend/src/infrastructure/index.js';
import { readEnvFile } from './root-env.js';

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const [domain, ip, selector = 'koala'] = process.argv.slice(2);
const env: Record<string, string | undefined> = { ...readEnvFile(process.env.COMPOSE_ENV ?? join(REPO, '.env')), ...process.env };
const provider = env.DOMAIN_DNS;
if (!domain || !ip || !provider) {
  console.error('usage: tsx mail-dns.ts <domain> <public ip> [selector] < <opendkim txt file>   (DOMAIN_DNS and its provider\'s credentials in the env or root\'s .env)');
  process.exit(2);
}

async function main(): Promise<void> {
  const described = dnsProviderNamed(provider!);
  const credentials = credentialsFromEnv(described, env);
  if (!credentials) throw new Error(`${described.label} credentials are not set: ${described.credential.filter((field) => !field.optional).map((field) => field.env).join(', ')}`);
  const wanted = { domain: domain!, ip: ip!, selector, dkim: dkimValue(readFileSync(0, 'utf8')) };
  const dns = new DnsProviders();
  const zone = await dns.zone(provider!, credentials, domain!);
  const { done, lines } = await dns.apply(zone, await dns.plan(zone, mailRecords(wanted)));
  for (const line of lines) console.log(`  ${line.startsWith('left as it is') ? '!' : '✓'} ${line}`);
  for (const line of mailByHand(wanted)) console.log(`  ! ${line}`);
  console.log(`  The lines marked ! are yours to do; mail is sent either way, but may land in spam until they are.${done ? '' : ' Koala left records it did not make as they are.'}`);
}

main().catch((err: Error) => {
  console.error(`  ✗ ${err.message}`);
  process.exit(1);
});
