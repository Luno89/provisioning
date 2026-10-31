export const EXPIRY_MARGIN_DAYS = 14;

export const SCANNED_PORTS: readonly number[] = [21, 22, 23, 25, 53, 80, 110, 143, 443, 465, 587, 993, 2375, 2376, 2525, 3000, 3001, 3002, 5000, 5001, 5432, 6379, 6443, 7233, 7234, 7236, 8080, 8233, 8443, 9090, 9100, 10250, 27017, 30320, 30321, 30322, 31737];

export const NODE_PORTS = { first: 30000, last: 32767 } as const;

export const nodePortRange = (): number[] => Array.from({ length: NODE_PORTS.last - NODE_PORTS.first + 1 }, (_, at) => NODE_PORTS.first + at);

export const portsToScan = (): number[] => [...new Set([...SCANNED_PORTS, ...nodePortRange()])].sort((a, b) => a - b);

export const ALWAYS_OPEN: readonly number[] = [80, 443];

export interface SmokeResult {
  check: string;
  found: string;
  problem?: string | undefined;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function certificateProblem(validTo: Date, authorized: boolean, authorizationError: string | undefined, now: Date, marginDays = EXPIRY_MARGIN_DAYS): string | undefined {
  if (!authorized) return `the certificate is not trusted: ${authorizationError ?? 'no reason given'}`;
  const left = Math.floor((validTo.getTime() - now.getTime()) / DAY_MS);
  if (left < 0) return `the certificate expired ${-left} days ago`;
  if (left < marginDays) return `the certificate expires in ${left} days, under the ${marginDays} days Caddy should have renewed it by`;
  return undefined;
}

const headerOf = (headers: Readonly<Record<string, string | undefined>>, name: string): string | undefined =>
  Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];

export function headerProblems(headers: Readonly<Record<string, string | undefined>>): string[] {
  const problems: string[] = [];
  if (!headerOf(headers, 'content-security-policy')) problems.push('no Content-Security-Policy');
  const hsts = headerOf(headers, 'strict-transport-security');
  if (!hsts) problems.push('no Strict-Transport-Security');
  else if (!/max-age=\d{6,}/.test(hsts)) problems.push(`Strict-Transport-Security is short: ${hsts}`);
  if (headerOf(headers, 'x-content-type-options')?.toLowerCase() !== 'nosniff') problems.push('X-Content-Type-Options is not nosniff');
  return problems;
}

const joined = (parts: readonly string[]): string => parts.join('');

export interface MailRecordsSeen {
  domain: string;
  ip: string;
  mailHostA: readonly string[];
  domainTxt: readonly (readonly string[])[];
  dkimTxt: readonly (readonly string[])[];
  dmarcTxt: readonly (readonly string[])[];
}

export function mailRecordProblems(seen: MailRecordsSeen): string[] {
  const problems: string[] = [];
  if (!seen.mailHostA.includes(seen.ip)) problems.push(`mail.${seen.domain} resolves to ${seen.mailHostA.join(', ') || 'nothing'}, not root's ${seen.ip}`);
  const spf = seen.domainTxt.map(joined).find((value) => value.startsWith('v=spf1'));
  if (!spf) problems.push(`${seen.domain} has no SPF record`);
  else if (!spf.split(/\s+/).includes(`ip4:${seen.ip}`)) problems.push(`${seen.domain}'s SPF (${spf}) does not name ip4:${seen.ip}`);
  const dkim = seen.dkimTxt.map(joined).find((value) => value.startsWith('v=DKIM1'));
  if (!dkim) problems.push(`koala._domainkey.${seen.domain} has no DKIM key`);
  else if (!/p=[A-Za-z0-9+/=]{100,}/.test(dkim)) problems.push(`koala._domainkey.${seen.domain} holds no public key`);
  if (!seen.dmarcTxt.map(joined).some((value) => value.startsWith('v=DMARC1'))) problems.push(`_dmarc.${seen.domain} has no DMARC record`);
  return problems;
}

export function portProblems(open: readonly number[], sshPublic: boolean): string[] {
  const allowed = new Set([...ALWAYS_OPEN, ...(sshPublic ? [22] : [])]);
  const problems: string[] = [];
  for (const port of open) if (!allowed.has(port)) problems.push(`port ${port} answers from outside`);
  for (const port of ALWAYS_OPEN) if (!open.includes(port)) problems.push(`port ${port} does not answer`);
  return problems;
}

export function portSummary(open: readonly number[], scanned: number, address: string): string {
  const nodePorts = open.filter((port) => port >= NODE_PORTS.first && port <= NODE_PORTS.last);
  return `${address}: of ${scanned} ports (${NODE_PORTS.first}–${NODE_PORTS.last}, every port Kubernetes gives a NodePort, among them), ${open.join(', ') || 'none'} answer${nodePorts.length ? `, ${nodePorts.length} of them node ports` : ''}`;
}

export const unknownName = (peopleDomain: string, random: string): string => `smoke${random.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12)}.${peopleDomain}`;

export function summary(results: readonly SmokeResult[]): { lines: string[]; failed: number } {
  const lines = results.map((result) => `${result.problem ? '✗' : '✓'} ${result.check}: ${result.problem ?? result.found}`);
  return { lines, failed: results.filter((result) => result.problem).length };
}
