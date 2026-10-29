import type { WantedRecord } from './dns-plan.js';

export type ServerOrderState =
  | 'quoted'
  | 'quote-cancelled'
  | 'bought'
  | 'paying'
  | 'waiting-check'
  | 'delivering'
  | 'installing-key'
  | 'waiting-ssh'
  | 'dns'
  | 'waiting-release'
  | 'bootstrapping'
  | 'ready'
  | 'failed'
  | 'stopped';

export interface ServerQuoteLine {
  description: string;
  amount: number;
}

export interface ServerQuote {
  currency: string;
  withoutTax: number;
  tax: number;
  withTax: number;
  monthly: number;
  setupFee: number;
  lines: ServerQuoteLine[];
  contracts: { name: string; url: string }[];
}

export interface ServerOrder {
  id: string;
  ownerId: string;
  provider: 'ovh';
  purpose: 'root';
  subsidiary: string;
  planCode: string;
  planLabel: string;
  datacenter: string;
  domain: string;
  ingressDomain: string;
  acmeEmail: string;
  dns: { domain: string; ingress: string };
  cartId?: string | undefined;
  quote: ServerQuote;
  quotedAt: string;
  orderId?: number | undefined;
  boughtAt?: string | undefined;
  serviceName?: string | undefined;
  ip?: string | undefined;
  release?: string | undefined;
  state: ServerOrderState;
  detail?: string | undefined;
  log?: string[] | undefined;
  sshPublicKey?: string | undefined;
  sshPrivateKey?: string | undefined;
  setupCode?: string | undefined;
  setupCodeShownAt?: string | undefined;
  workflowId?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export const SERVER_ORDER_LOG_LINES = 2000;

export const rootNodeWorkflowId = (orderId: string): string => `root-node-${orderId}`;

export const FOLLOWING: readonly ServerOrderState[] = ['bought', 'paying', 'waiting-check', 'delivering', 'installing-key', 'waiting-ssh', 'dns', 'waiting-release', 'bootstrapping'];

export const STATE_SAID: Record<ServerOrderState, string> = {
  quoted: 'Priced, waiting for you to buy or cancel',
  'quote-cancelled': 'Cancelled before buying; nothing was charged',
  bought: 'Bought; OVHcloud is taking the order',
  paying: 'Waiting for OVHcloud to take the payment',
  'waiting-check': 'Waiting for OVHcloud to check the order (a first order can take 24–48 hours, and OVHcloud may email you for documents)',
  delivering: 'OVHcloud is delivering the server',
  'installing-key': 'Reinstalling the server with Ubuntu 24.04 and Koala\'s SSH key',
  'waiting-ssh': 'Waiting for the server to answer on SSH',
  dns: 'Pointing the domains at the server',
  'waiting-release': 'Waiting for a signed Koala release to install',
  bootstrapping: 'Installing Koala\'s root on the server',
  ready: 'Root is running',
  failed: 'Stopped on a problem',
  stopped: 'No longer followed',
};

interface OvhPrice { value?: unknown; currencyCode?: unknown }
interface OvhCheckout {
  prices?: { withoutTax?: OvhPrice; tax?: OvhPrice; withTax?: OvhPrice };
  details?: { description?: unknown; detailType?: unknown; totalPrice?: OvhPrice }[];
  contracts?: { name?: unknown; url?: unknown }[];
}

const amountOf = (price: OvhPrice | undefined): number => {
  const value = Number(price?.value);
  return Number.isFinite(value) ? value : 0;
};

const cents = (n: number): number => Math.round(n * 100) / 100;

export function quoteFromCheckout(checkout: unknown): ServerQuote {
  const order = (checkout ?? {}) as OvhCheckout;
  const currency = String(order.prices?.withTax?.currencyCode ?? order.prices?.withoutTax?.currencyCode ?? '');
  if (!currency) throw new Error('OVHcloud priced the cart without a currency');
  const details = order.details ?? [];
  const lines = details.map((detail) => ({ description: String(detail.description ?? ''), amount: cents(amountOf(detail.totalPrice)) }));
  const setupFee = cents(details.filter((detail) => detail.detailType === 'INSTALLATION').reduce((sum, detail) => sum + amountOf(detail.totalPrice), 0));
  const monthly = cents(details.filter((detail) => detail.detailType !== 'INSTALLATION').reduce((sum, detail) => sum + amountOf(detail.totalPrice), 0));
  return {
    currency,
    withoutTax: cents(amountOf(order.prices?.withoutTax)),
    tax: cents(amountOf(order.prices?.tax)),
    withTax: cents(amountOf(order.prices?.withTax)),
    monthly,
    setupFee,
    lines,
    contracts: (order.contracts ?? []).flatMap((contract) => (typeof contract.name === 'string' && typeof contract.url === 'string' ? [{ name: contract.name, url: contract.url }] : [])),
  };
}

export function priceChangeProblem(quoted: ServerQuote, now: ServerQuote, confirmed: number): string | undefined {
  if (confirmed !== quoted.withTax) return `You confirmed ${confirmed} ${quoted.currency}, but the quote shown was ${quoted.withTax} ${quoted.currency}; price it again.`;
  if (now.currency !== quoted.currency || now.withTax !== quoted.withTax) {
    return `OVHcloud now prices this at ${now.withTax} ${now.currency}, not the ${quoted.withTax} ${quoted.currency} you confirmed; nothing was bought. Price it again.`;
  }
  return undefined;
}

interface OptionDefinition { planCode?: unknown; family?: unknown; mandatory?: unknown; prices?: { duration?: unknown; pricingMode?: unknown; price?: OvhPrice }[] }

export interface ChosenOption { planCode: string; family: string; amount: number }

export function mandatoryOptions(definitions: unknown, duration = 'P1M', pricingMode = 'default'): ChosenOption[] {
  const all = (Array.isArray(definitions) ? definitions : []) as OptionDefinition[];
  const families = new Map<string, ChosenOption[]>();
  for (const definition of all) {
    if (definition.mandatory !== true || typeof definition.planCode !== 'string') continue;
    const family = String(definition.family ?? definition.planCode);
    const price = (definition.prices ?? []).find((entry) => entry.duration === duration && entry.pricingMode === pricingMode);
    if (!price) continue;
    families.set(family, [...(families.get(family) ?? []), { planCode: definition.planCode, family, amount: amountOf(price.price) }]);
  }
  const missing = [...new Set(all.filter((definition) => definition.mandatory === true).map((definition) => String(definition.family ?? definition.planCode)))]
    .filter((family) => !families.has(family));
  if (missing.length) throw new Error(`OVHcloud offers no ${duration} price for the mandatory option${missing.length === 1 ? '' : 's'} ${missing.join(', ')}`);
  return [...families.values()].map((options) => [...options].sort((a, b) => a.amount - b.amount || a.planCode.localeCompare(b.planCode))[0]!);
}

interface RequiredConfiguration { label?: unknown; required?: unknown; allowedValues?: unknown }

export const ROOT_OS = 'Ubuntu 24.04';

export function configurationFor(required: unknown, wanted: Record<string, string>): { label: string; value: string }[] {
  const items = (Array.isArray(required) ? required : []) as RequiredConfiguration[];
  const out: { label: string; value: string }[] = [];
  for (const item of items) {
    const label = String(item.label ?? '');
    const value = wanted[label];
    if (value === undefined) {
      if (item.required === true) throw new Error(`OVHcloud asks for "${label}", which Koala does not know how to answer`);
      continue;
    }
    const allowed = Array.isArray(item.allowedValues) ? item.allowedValues.map(String) : undefined;
    if (allowed && allowed.length && !allowed.includes(value)) throw new Error(`OVHcloud does not offer ${label} "${value}" for this plan; it offers ${allowed.join(', ')}`);
    out.push({ label, value });
  }
  for (const [label, value] of Object.entries(wanted)) if (!out.some((entry) => entry.label === label)) out.push({ label, value });
  return out;
}

export function orderStateOf(status: string): ServerOrderState | 'unknown' {
  switch (status) {
    case 'notPaid': return 'paying';
    case 'checking':
    case 'documentsRequested': return 'waiting-check';
    case 'delivering': return 'delivering';
    case 'delivered': return 'installing-key';
    case 'cancelled':
    case 'cancelling': return 'failed';
    default: return 'unknown';
  }
}

export interface RootDnsRecord {
  zone: string;
  wanted: WantedRecord;
}

const pointedAt = (name: string, ip: string): WantedRecord => ({
  type: 'A',
  name,
  content: ip,
  onConflict: 'refuse',
  why: `${name} points at the new root (DNS only)`,
  kept: `${name} already points at ${ip}`,
  refused: (found) => `${name} already points at ${found.map((record) => record.content).join(', ')}; Koala does not change a record it did not make. Point it at ${ip} (DNS only) or delete it, and the install carries on.`,
});

export function rootDnsRecords(domain: string, ingressDomain: string, ip: string): RootDnsRecord[] {
  return [
    { zone: domain, wanted: pointedAt(`app.${domain}`, ip) },
    { zone: domain, wanted: pointedAt(`mesh.${domain}`, ip) },
    { zone: ingressDomain, wanted: pointedAt(`*.${ingressDomain}`, ip) },
  ];
}

export function newestRelease(lsRemote: string): string | undefined {
  const tags = lsRemote.split('\n')
    .map((line) => /refs\/tags\/(v\d{4}\.\d{2}\.\d{2}(?:-\d+)?)$/.exec(line.trim())?.[1])
    .filter((tag): tag is string => Boolean(tag));
  const key = (tag: string) => {
    const [, date = '', n = '0'] = /^v(\d{4}\.\d{2}\.\d{2})(?:-(\d+))?$/.exec(tag) ?? [];
    return `${date}.${n.padStart(4, '0')}`;
  };
  return [...new Set(tags)].sort((a, b) => key(b).localeCompare(key(a)))[0];
}

export const KOALA_REPOSITORY = 'https://github.com/Luno89/provisioning.git';

export interface BootstrapInputs {
  release: string;
  domain: string;
  ingressDomain: string;
  acmeEmail: string;
  domainDns: string;
  ingressDns: string;
  dnsEnv: Readonly<Record<string, string>>;
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

export function bootstrapScript(inputs: BootstrapInputs, repository = KOALA_REPOSITORY): string {
  const credentials = Object.entries(inputs.dnsEnv).map(([name, value]) => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`${name} is not an environment variable name`);
    return `export ${name}=${shellQuote(value)}`;
  });
  return [
    'set -euo pipefail',
    'export DEBIAN_FRONTEND=noninteractive',
    'command -v git >/dev/null || { apt-get update -qq && apt-get install -y -qq git >/dev/null; }',
    `[ -d /opt/nowrinkles/.git ] || git clone -q ${shellQuote(repository)} /opt/nowrinkles`,
    'cd /opt/nowrinkles',
    'git fetch -q --tags --prune',
    `git checkout -q --detach ${shellQuote(inputs.release)}`,
    `export DOMAIN=${shellQuote(inputs.domain)} INGRESS_DOMAIN=${shellQuote(inputs.ingressDomain)} ACME_EMAIL=${shellQuote(inputs.acmeEmail)}`,
    `export CERTIFICATES=acme DOMAIN_DNS=${shellQuote(inputs.domainDns)} INGRESS_DNS=${shellQuote(inputs.ingressDns)}`,
    ...credentials,
    'bash scripts/root-node/bootstrap.sh',
    'systemctl start nowrinkles',
    'bash scripts/root-node/release-watch.sh',
    'echo "KOALA-ROOT-READY"',
  ].join('\n');
}

export const READY_MARK = 'KOALA-ROOT-READY';

export function setupCodeFrom(envText: string): string | undefined {
  const value = /^ADMIN_SETUP_CODE=(.+)$/m.exec(envText)?.[1]?.trim();
  return value || undefined;
}

export function redacted(line: string, secrets: readonly string[]): string {
  return secrets.filter((secret) => secret.length >= 6).reduce((out, secret) => out.split(secret).join('••••'), line);
}

export function rootDomainProblem(domain: string, ingressDomain: string): string | undefined {
  const name = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
  if (!name.test(domain)) return `${domain || 'The root domain'} is not a domain name`;
  if (!name.test(ingressDomain)) return `${ingressDomain || 'The people\'s domain'} is not a domain name`;
  const registered = (value: string) => value.split('.').slice(-2).join('.');
  if (registered(domain) === registered(ingressDomain)) return 'People\'s instances and apps must be under a different registered domain from root\'s, or a page someone deploys would count as root\'s own site.';
  return undefined;
}
