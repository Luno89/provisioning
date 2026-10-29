import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolveNs } from 'node:dns/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  caddyDnsEnv, caddyModules, caddyTlsSnippet, credentialsFromEnv, dnsProviderNamed, providerForNameservers, rootDnsSettingsFrom,
} from '../../apps/backend/src/infrastructure/lib/dns-providers.js';
import { readEnvFile, setEnvValues } from './root-env.js';

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const COMPOSE_ENV = process.env.COMPOSE_ENV ?? join(REPO, '.env');
const CADDY_DIR = process.env.KOALA_CADDY_DIR ?? '/etc/koala';

const fail = (message: string): never => {
  console.error(`  ❌ ${message}`);
  process.exit(1);
};

async function providerOf(zone: string, setting: string, given: string | undefined): Promise<string> {
  if (given) return given;
  let nameservers: string[] = [];
  try {
    nameservers = await resolveNs(zone);
  } catch (error) {
    return fail(`${zone} has no nameservers Koala can find (${(error as { code?: string }).code ?? (error as Error).message}); set ${setting} to its DNS provider`);
  }
  const found = providerForNameservers(nameservers);
  if ('problem' in found) return fail(`${zone}: ${found.problem} (${setting})`);
  console.log(`  ✅ ${zone} is served by ${dnsProviderNamed(found.provider).label} (its nameservers say so)`);
  return found.provider;
}

async function setup(): Promise<void> {
  const env = { ...readEnvFile(COMPOSE_ENV), ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) };
  const settings = rootDnsSettingsFrom(env);
  if ('problem' in settings) return fail(settings.problem);
  mkdirSync(join(CADDY_DIR, 'caddy-tls'), { recursive: true });
  const envFile = join(CADDY_DIR, 'caddy-dns.env');

  if (settings.certificates === 'internal') {
    writeFileSync(join(CADDY_DIR, 'caddy-tls', 'koala.caddy'), caddyTlsSnippet('internal'));
    writeFileSync(envFile, '', { mode: 0o600 });
    chmodSync(envFile, 0o600);
    setEnvValues(COMPOSE_ENV, { CERTIFICATES: 'internal', ROOT_TLS: 'internal' });
    console.log('  ✅ Caddy signs with its own certificate authority (a lab)');
    return;
  }

  const domain = env.DOMAIN ?? fail('DOMAIN is not set');
  const ingress = env.INGRESS_DOMAIN ?? fail('INGRESS_DOMAIN is not set');
  const domainDns = await providerOf(domain, 'DOMAIN_DNS', settings.domainDns);
  const ingressDns = await providerOf(ingress, 'INGRESS_DNS', settings.ingressDns);
  const kept: Record<string, string> = { CERTIFICATES: 'acme', DOMAIN_DNS: domainDns, INGRESS_DNS: ingressDns };
  for (const name of new Set([domainDns, ingressDns])) {
    const described = dnsProviderNamed(name);
    const fields = credentialsFromEnv(described, env);
    if (!fields) return fail(`Set ${described.credential.filter((field) => !field.optional).map((field) => field.env).join(' and ')}: ${described.setup} Caddy proves the domain with them for the wildcard certificate, and the DNS records are made with them. They stay in ${COMPOSE_ENV}, never in the database.`);
    for (const field of described.credential) if (fields[field.key]) kept[field.env] = fields[field.key]!;
  }
  if (ingressDns === 'cloudflare') kept.ROOT_TLS = 'cloudflare';
  setEnvValues(COMPOSE_ENV, kept);
  const ingressProvider = dnsProviderNamed(ingressDns);
  writeFileSync(join(CADDY_DIR, 'caddy-tls', 'koala.caddy'), caddyTlsSnippet('acme', ingressProvider));
  writeFileSync(envFile, caddyDnsEnv(ingressProvider, { ...env, ...kept }), { mode: 0o600 });
  chmodSync(envFile, 0o600);
  console.log(`  ✅ Caddy gets the wildcard certificate for *.${ingress} over ${ingressProvider.label}; ${domain}'s records go through ${dnsProviderNamed(domainDns).label}`);
}

function modules(): void {
  const pins = JSON.parse(readFileSync(join(REPO, 'dependencies.pins.json'), 'utf8')) as { components: { kind: string; name: string; version: string }[] };
  process.stdout.write(caddyModules(pins.components));
}

const command = process.argv[2];
if (command === 'setup') {
  setup().catch((error: Error) => fail(error.message));
} else if (command === 'caddy-modules') {
  modules();
} else {
  console.error('usage: tsx scripts/root-node/dns.ts setup | caddy-modules');
  process.exit(2);
}
