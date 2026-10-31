export type DnsAnswer = { found: string[] } | { missing: true } | { error: string };

export interface Blocklist {
  name: string;
  zone: string;
  removal: string;
  terms: string;
}

export const MAIL_BLOCKLISTS: readonly Blocklist[] = [
  {
    name: 'Spamhaus ZEN',
    zone: 'zen.spamhaus.org',
    removal: 'https://check.spamhaus.org/',
    terms: 'free for low-volume use; it answers 127.255.255.254 to queries through public resolvers such as 1.1.1.1, and Google\'s resolver gets no answer at all, so root asks its own resolver',
  },
  {
    name: 'Barracuda',
    zone: 'b.barracudacentral.org',
    removal: 'https://www.barracudacentral.org/rbl/removal-request',
    terms: 'free; Barracuda asks heavy users to register the resolver they query from',
  },
  {
    name: 'UCEPROTECT level 1',
    zone: 'dnsbl-1.uceprotect.net',
    removal: 'https://www.uceprotect.net/en/rblcheck.php',
    terms: 'free for low-volume use; level 1 lists single addresses, never a whole provider\'s range',
  },
];

export const BLOCKLIST_TEST_ADDRESS = '127.0.0.2';
export const PORT_25_PROBE = 'gmail-smtp-in.l.google.com';

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export const isIpv4 = (value: string): boolean => {
  const match = IPV4.exec(value);
  return Boolean(match && match.slice(1).every((part) => Number(part) <= 255));
};

export function blocklistQuery(ip: string, zone: string): string {
  if (!isIpv4(ip)) throw new Error(`${ip} is not an IPv4 address`);
  return `${ip.split('.').reverse().join('.')}.${zone}`;
}

export const mailHostOf = (domain: string): string => `mail.${domain}`;

export function mailDomainFrom(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const domain = env.DOMAIN?.trim() || env.MAIL_FROM?.trim().split('@')[1]?.trim();
  return domain ? domain.toLowerCase() : undefined;
}

const RESOLVER_CODES: Record<string, string> = {
  '127.255.255.252': 'the list says its name was mistyped',
  '127.255.255.254': 'the list refuses queries that come through a public resolver',
  '127.255.255.255': 'the list says this resolver has asked too often',
};

export type BlocklistState = 'clear' | 'listed' | 'unknown';

export interface BlocklistResult {
  name: string;
  zone: string;
  state: BlocklistState;
  said: string;
  codes?: string[] | undefined;
  removal?: string | undefined;
}

const refusalOf = (answer: DnsAnswer): string | undefined =>
  'found' in answer ? answer.found.map((code) => RESOLVER_CODES[code]).find(Boolean) : undefined;

export function blocklistVerdict(list: Blocklist, ip: string, test: DnsAnswer, own: DnsAnswer): BlocklistResult {
  const base = { name: list.name, zone: list.zone };
  const refused = refusalOf(own) ?? refusalOf(test);
  if (refused) return { ...base, state: 'unknown', said: `${list.name} could not be asked: ${refused}` };
  if ('error' in own) return { ...base, state: 'unknown', said: `${list.name} could not be asked: ${own.error}` };
  if ('found' in own) {
    return { ...base, state: 'listed', codes: own.found, removal: list.removal, said: `${ip} is on ${list.name} (${own.found.join(', ')}); mail from root may be refused or land in spam until it is removed at ${list.removal}` };
  }
  if (!('found' in test)) {
    return { ...base, state: 'unknown', said: `${list.name} does not answer for its own test address ${BLOCKLIST_TEST_ADDRESS} through this resolver, so its silence about ${ip} proves nothing` };
  }
  return { ...base, state: 'clear', said: `${ip} is not on ${list.name}` };
}

const bareName = (name: string): string => name.trim().toLowerCase().replace(/\.$/, '');

export type ReverseState = 'matches' | 'differs' | 'none' | 'unknown';

export interface ReverseDnsResult {
  state: ReverseState;
  names: string[];
  said: string;
}

export function reverseDnsVerdict(ip: string, expected: string, ptr: DnsAnswer): ReverseDnsResult {
  const want = bareName(expected);
  if ('error' in ptr) return { state: 'unknown', names: [], said: `the reverse DNS of ${ip} could not be read: ${ptr.error}` };
  if (!('found' in ptr) || ptr.found.length === 0) return { state: 'none', names: [], said: `${ip} has no reverse DNS; set its PTR to ${want}` };
  const names = ptr.found.map(bareName);
  if (names.includes(want)) return { state: 'matches', names, said: `${ip} reverses to ${want}` };
  return { state: 'differs', names, said: `${ip} reverses to ${names.join(', ')}, not ${want}; set its PTR to ${want}` };
}

export type ForwardState = 'matches' | 'differs' | 'none' | 'unknown';

export interface ForwardResult {
  state: ForwardState;
  addresses: string[];
  said: string;
}

export function forwardVerdict(host: string, answer: DnsAnswer, ip?: string): ForwardResult {
  if ('error' in answer) return { state: 'unknown', addresses: [], said: `${host} could not be resolved: ${answer.error}` };
  if (!('found' in answer) || answer.found.length === 0) return { state: 'none', addresses: [], said: `${host} has no A record, so receivers cannot match root's reverse DNS forwards` };
  if (ip && !answer.found.includes(ip)) return { state: 'differs', addresses: answer.found, said: `${host} points at ${answer.found.join(', ')}, not ${ip}` };
  return { state: 'matches', addresses: answer.found, said: `${host} points at ${answer.found.join(', ')}` };
}

export interface Port25Result {
  open: boolean;
  relay?: string | undefined;
  said: string;
}

export function port25Verdict(reached: { ok: true } | { ok: false; error: string }, relayhost?: string): Port25Result {
  if (relayhost) return { open: reached.ok, relay: relayhost, said: `mail goes through ${relayhost} (MAIL_RELAYHOST)${reached.ok ? '' : `; outbound port 25 is closed (${reached.error}), which does not matter while mail goes through it`}` };
  if (reached.ok) return { open: true, said: `outbound port 25 is open, so root delivers mail itself (reached ${PORT_25_PROBE})` };
  return { open: false, said: `outbound port 25 looks closed (${PORT_25_PROBE}: ${reached.error}); ask the host to open it, or set MAIL_RELAYHOST=[host]:587 in root's .env beside docker-compose.mail.yml` };
}

export interface MailReadiness {
  domain: string;
  host: string;
  ip?: string | undefined;
  checkedAt: string;
  forward: ForwardResult;
  reverseDns?: ReverseDnsResult | undefined;
  port25: Port25Result;
  blocklists: BlocklistResult[];
}

export function mailProblems(readiness: MailReadiness): string[] {
  const problems: string[] = [];
  if (readiness.forward.state !== 'matches') problems.push(readiness.forward.said);
  if (readiness.reverseDns && readiness.reverseDns.state !== 'matches') problems.push(readiness.reverseDns.said);
  if (!readiness.port25.open && !readiness.port25.relay) problems.push(readiness.port25.said);
  for (const list of readiness.blocklists) if (list.state === 'listed') problems.push(list.said);
  return problems;
}

export function mailUnknowns(readiness: MailReadiness): string[] {
  return [
    ...(readiness.reverseDns?.state === 'unknown' ? [readiness.reverseDns.said] : []),
    ...readiness.blocklists.filter((list) => list.state === 'unknown').map((list) => list.said),
  ];
}

export interface MailLine {
  mark: 'ok' | 'problem' | 'unknown';
  said: string;
}

export interface MailReport {
  check: MailReadiness;
  lines: MailLine[];
  problems: string[];
}

export function mailLines(readiness: MailReadiness): MailLine[] {
  const problems = new Set(mailProblems(readiness));
  const unknowns = new Set(mailUnknowns(readiness));
  const said = [
    readiness.forward.said,
    ...(readiness.reverseDns ? [readiness.reverseDns.said] : []),
    readiness.port25.said,
    ...readiness.blocklists.map((list) => list.said),
  ];
  return said.map((line) => ({ mark: problems.has(line) ? 'problem' : unknowns.has(line) ? 'unknown' : 'ok', said: line }));
}

export const mailReport = (check: MailReadiness): MailReport => ({ check, lines: mailLines(check), problems: mailProblems(check) });

export const MAIL_CHECK_MARK = 'KOALA-MAIL-CHECK';

export function mailCheckFrom(output: string): MailReadiness | undefined {
  const line = output.split('\n').reverse().find((entry) => entry.startsWith(`${MAIL_CHECK_MARK} `));
  if (!line) return undefined;
  try {
    const parsed = JSON.parse(line.slice(MAIL_CHECK_MARK.length + 1)) as MailReadiness;
    return parsed && typeof parsed.domain === 'string' && Array.isArray(parsed.blocklists) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
