export type DnsRecordType = 'A' | 'CNAME' | 'TXT';

export interface DnsRecord {
  id?: string | undefined;
  type: DnsRecordType;
  name: string;
  content: string;
}

export interface DnsCredentialField {
  key: string;
  label: string;
  env: string;
  secret: boolean;
  placeholder: string;
  optional?: true;
  aliases?: readonly string[];
}

export interface DnsProviderDescription {
  name: string;
  label: string;
  docsUrl: string;
  setup: string;
  nameserverSuffixes: readonly string[];
  credential: readonly DnsCredentialField[];
  caddy: { module: string; directive: readonly string[] };
}

export interface DnsZone {
  name: string;
  all(): Promise<DnsRecord[]>;
  list(type: DnsRecordType, name: string): Promise<DnsRecord[]>;
  create(record: DnsRecord): Promise<void>;
  update(record: DnsRecord & { id: string }): Promise<void>;
  remove(record: DnsRecord & { id: string }): Promise<void>;
}

export interface DnsValidation {
  valid: boolean;
  message: string;
}

export type DnsCredentials = Readonly<Record<string, string>>;

export interface DnsProvider extends DnsProviderDescription {
  validate(credentials: DnsCredentials): Promise<DnsValidation>;
  zone(credentials: DnsCredentials, zone: string): Promise<DnsZone>;
}

export class DnsProviderRefusal extends Error {}

export const CLOUDFLARE_DNS: DnsProviderDescription = {
  name: 'cloudflare',
  label: 'Cloudflare DNS',
  docsUrl: 'https://dash.cloudflare.com/profile/api-tokens',
  setup: 'Make an API token with Zone → DNS → Edit on each zone Koala manages (a scoped token, not the Global API Key).',
  nameserverSuffixes: ['.ns.cloudflare.com'],
  credential: [
    { key: 'token', label: 'API Token (Zone → DNS → Edit)', env: 'CLOUDFLARE_API_TOKEN', secret: true, placeholder: 'scoped token, not the Global API Key', aliases: ['CF_API_TOKEN'] },
    { key: 'zone', label: 'Zone (Optional)', env: 'CLOUDFLARE_ZONE', secret: false, placeholder: 'nowrinkles.dev', optional: true },
  ],
  caddy: { module: 'github.com/caddy-dns/cloudflare', directive: ['dns cloudflare {env.CLOUDFLARE_API_TOKEN}'] },
};

export const PORKBUN_ACCESS = 'Porkbun answers only for a domain with API Access turned on: in Porkbun, Domain Management → the domain → Details → API Access.';

export const PORKBUN_DNS: DnsProviderDescription = {
  name: 'porkbun',
  label: 'Porkbun DNS',
  docsUrl: 'https://porkbun.com/account/api',
  setup: `Make an API key and secret key under Account → API Access. ${PORKBUN_ACCESS}`,
  nameserverSuffixes: ['.ns.porkbun.com'],
  credential: [
    { key: 'apiKey', label: 'API Key', env: 'PORKBUN_API_KEY', secret: true, placeholder: 'pk1_…' },
    { key: 'secretApiKey', label: 'Secret API Key', env: 'PORKBUN_API_SECRET_KEY', secret: true, placeholder: 'sk1_…' },
  ],
  caddy: {
    module: 'github.com/caddy-dns/porkbun',
    directive: ['dns porkbun {', '\tapi_key {env.PORKBUN_API_KEY}', '\tapi_secret_key {env.PORKBUN_API_SECRET_KEY}', '}'],
  },
};

export const DNS_PROVIDERS: readonly DnsProviderDescription[] = [CLOUDFLARE_DNS, PORKBUN_DNS];

export const DNS_PROVIDER_NAMES = ['cloudflare', 'porkbun'] as const;

export type DnsProviderName = typeof DNS_PROVIDER_NAMES[number];

export const isDnsProviderName = (value: unknown): value is DnsProviderName =>
  typeof value === 'string' && (DNS_PROVIDER_NAMES as readonly string[]).includes(value);

export function dnsProviderNamed(name: string): DnsProviderDescription {
  const found = DNS_PROVIDERS.find((provider) => provider.name === name);
  if (!found) throw new DnsProviderRefusal(`${name} is not a DNS provider Koala knows (it knows ${DNS_PROVIDERS.map((provider) => provider.name).join(', ')})`);
  return found;
}

export function providerForNameservers(nameservers: readonly string[]): { provider: string } | { problem: string } {
  const lower = nameservers.map((server) => server.toLowerCase().replace(/\.$/, ''));
  const found = DNS_PROVIDERS.find((provider) => lower.length > 0 && lower.every((server) => provider.nameserverSuffixes.some((suffix) => server.endsWith(suffix))));
  if (found) return { provider: found.name };
  if (lower.length === 0) return { problem: 'the zone has no nameservers, so no DNS provider serves it yet' };
  return { problem: `its nameservers (${lower.join(', ')}) are not ${DNS_PROVIDERS.map((provider) => provider.label).join(' or ')}; set the provider by hand if Koala should use one of those, or move the zone to one` };
}

export const credentialEnvOf = (provider: DnsProviderDescription, fields: Readonly<Record<string, string | undefined>> | undefined): Record<string, string> | undefined => {
  const env: Record<string, string> = {};
  for (const field of provider.credential) {
    const value = fields?.[field.key]?.trim();
    if (value) env[field.env] = value;
    else if (!field.optional) return undefined;
  }
  return env;
};

export const credentialsFromEnv = (provider: DnsProviderDescription, env: Readonly<Record<string, string | undefined>>): Record<string, string> | undefined => {
  const fields: Record<string, string> = {};
  for (const field of provider.credential) {
    const value = [field.env, ...(field.aliases ?? [])].map((name) => env[name]?.trim()).find(Boolean);
    if (value) fields[field.key] = value;
    else if (!field.optional) return undefined;
  }
  return fields;
};

export const secretFieldsOf = (provider: DnsProviderDescription): string[] => provider.credential.filter((field) => field.secret).map((field) => field.key);

export const plainFieldsOf = (provider: DnsProviderDescription): string[] => provider.credential.filter((field) => !field.secret).map((field) => field.key);

export type Certificates = 'acme' | 'internal';

export interface RootDnsSettings {
  certificates: Certificates;
  domainDns?: string | undefined;
  ingressDns?: string | undefined;
}

export function rootDnsSettingsFrom(env: Readonly<Record<string, string | undefined>>): RootDnsSettings | { problem: string } {
  const legacy = env.ROOT_TLS?.trim();
  const asked = env.CERTIFICATES?.trim() || (legacy === 'internal' ? 'internal' : legacy === 'cloudflare' || !legacy ? 'acme' : legacy);
  if (asked !== 'acme' && asked !== 'internal') return { problem: `CERTIFICATES is acme (Let's Encrypt, proved over the people's domain's DNS) or internal (a lab: Caddy's own authority, no public DNS), not ${asked}` };
  const fromLegacy = legacy === 'cloudflare' ? 'cloudflare' : undefined;
  const domainDns = env.DOMAIN_DNS?.trim() || fromLegacy;
  const ingressDns = env.INGRESS_DNS?.trim() || fromLegacy;
  for (const [setting, value] of [['DOMAIN_DNS', domainDns], ['INGRESS_DNS', ingressDns]] as const) {
    if (value && !DNS_PROVIDERS.some((provider) => provider.name === value)) return { problem: `${setting} is ${value}, which is not a DNS provider Koala knows (${DNS_PROVIDERS.map((provider) => provider.name).join(', ')})` };
  }
  return { certificates: asked, ...(domainDns ? { domainDns } : {}), ...(ingressDns ? { ingressDns } : {}) };
}

export function caddyTlsSnippet(certificates: Certificates, provider?: DnsProviderDescription): string {
  if (certificates === 'internal') return 'tls internal\n';
  if (!provider) throw new DnsProviderRefusal('certificates from Let\'s Encrypt need the DNS provider of the people\'s domain, for its wildcard');
  return ['tls {', ...provider.caddy.directive.map((line) => `\t${line}`), '}', ''].join('\n');
}

export function caddyDnsEnv(provider: DnsProviderDescription | undefined, env: Readonly<Record<string, string | undefined>>): string {
  if (!provider) return '';
  return provider.credential.filter((field) => !field.optional).map((field) => {
    const value = env[field.env]?.trim();
    if (!value) throw new DnsProviderRefusal(`${field.env} is not set, and Caddy needs it for ${provider.label}`);
    if (/[\r\n]/.test(value)) throw new DnsProviderRefusal(`${field.env} holds a line break`);
    return `${field.env}=${value}\n`;
  }).join('');
}

export function caddyModules(pins: readonly { kind: string; name: string; version: string }[]): string {
  return DNS_PROVIDERS.map((provider) => {
    const pin = pins.find((entry) => entry.kind === 'go' && entry.name === provider.caddy.module);
    if (!pin) throw new DnsProviderRefusal(`dependencies.pins.json pins no version of ${provider.caddy.module}, which ${provider.label} needs in Caddy`);
    return `${provider.caddy.module}@${pin.version}\n`;
  }).join('');
}

export const describeProvider = (provider: DnsProviderDescription) => ({
  name: provider.name,
  label: provider.label,
  docsUrl: provider.docsUrl,
  setup: provider.setup,
  fields: provider.credential.map(({ key, label, secret, placeholder, optional }) => ({ key, label, secret, placeholder, optional: optional === true })),
});
