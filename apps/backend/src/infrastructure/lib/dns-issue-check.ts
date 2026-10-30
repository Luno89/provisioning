import { caddyTlsSnippet, type DnsProviderDescription, type DnsRecord } from './dns-providers.js';

export const STAGING_CA = 'https://acme-staging-v02.api.letsencrypt.org/directory';

export const ISSUE_CHECK_LABEL = 'koala-check';

export const checkNameIn = (zone: string): string => `${ISSUE_CHECK_LABEL}.${zone.toLowerCase().replace(/\.$/, '')}`;

export const checkWildcardIn = (zone: string): string => `*.${checkNameIn(zone)}`;

export const challengeNameIn = (zone: string): string => `_acme-challenge.${checkNameIn(zone)}`;

export function issueCheckCaddyfile(zone: string): string {
  return [
    '{',
    `\tacme_ca ${STAGING_CA}`,
    '\tstorage file_system /data',
    '\tadmin off',
    '\tlog {',
    '\t\toutput stderr',
    '\t\tformat json',
    '\t}',
    '}',
    '',
    '(koala_tls) {',
    '\timport /etc/caddy/tls/koala.caddy',
    '}',
    '',
    `${checkWildcardIn(zone)} {`,
    '\timport koala_tls',
    '\trespond 404',
    '}',
    '',
  ].join('\n');
}

export const issueCheckTlsSnippet = (provider: DnsProviderDescription): string => caddyTlsSnippet('acme', provider);

interface AdaptedIssuer { module?: string; ca?: string }
interface AdaptedPolicy { subjects?: string[]; issuers?: AdaptedIssuer[] }
interface AdaptedConfig { apps?: { tls?: { automation?: { policies?: AdaptedPolicy[] } } } }

export function stagingOnlyProblem(adapted: AdaptedConfig, zone: string): string | undefined {
  const policies = adapted.apps?.tls?.automation?.policies ?? [];
  const wildcard = checkWildcardIn(zone);
  if (!policies.some((policy) => policy.subjects?.includes(wildcard))) return `Caddy's configuration has no certificate policy for ${wildcard}`;
  for (const policy of policies) {
    const about = policy.subjects?.join(', ') ?? 'every other name';
    if (!policy.issuers?.length) return `the certificate policy for ${about} names no issuer, so Caddy would use its defaults, which are not only Let's Encrypt's staging service`;
    for (const issuer of policy.issuers) {
      if (issuer.module !== 'acme' || issuer.ca !== STAGING_CA) return `the certificate policy for ${about} would ask ${issuer.ca ?? issuer.module ?? 'an issuer it does not name'}, not Let's Encrypt's staging service`;
    }
  }
  return undefined;
}

export type CaddyEvent =
  | { kind: 'obtaining' }
  | { kind: 'obtained'; issuer: string }
  | { kind: 'attempt-failed'; error: string }
  | { kind: 'cleanup-failed'; error: string };

export function caddyEvent(line: string, zone: string): CaddyEvent | undefined {
  let entry: { msg?: unknown; identifier?: unknown; issuer?: unknown; error?: unknown; level?: unknown; logger?: unknown };
  try {
    entry = JSON.parse(line) as typeof entry;
  } catch {
    return undefined;
  }
  const message = typeof entry.msg === 'string' ? entry.msg : '';
  const error = typeof entry.error === 'string' ? entry.error : message;
  const ours = entry.identifier === undefined || entry.identifier === checkWildcardIn(zone);
  if (!ours) return undefined;
  if (message === 'obtaining certificate') return { kind: 'obtaining' };
  if (message === 'certificate obtained successfully') return { kind: 'obtained', issuer: typeof entry.issuer === 'string' ? entry.issuer : '' };
  if (message === 'could not get certificate from issuer' || message === 'job failed' || message === 'will retry') return { kind: 'attempt-failed', error };
  if (entry.level === 'error' && typeof entry.logger === 'string' && entry.logger.startsWith('tls')) {
    if (/clean(ing)? ?up|deleting temporary record/i.test(message)) return { kind: 'cleanup-failed', error };
    return { kind: 'attempt-failed', error };
  }
  return undefined;
}

export const certificatePathIn = (zone: string): string => {
  const issuerKey = new URL(STAGING_CA).host + new URL(STAGING_CA).pathname.replace(/\//g, '-');
  const site = `wildcard_.${checkNameIn(zone)}`;
  return `certificates/${issuerKey}/${site}/${site}.crt`;
};

export interface IssuedCertificate {
  names: string[];
  issuer: string;
  validFrom: Date;
  validTo: Date;
}

export const namesFromSubjectAltName = (subjectAltName: string | undefined): string[] =>
  (subjectAltName ?? '').split(',').map((entry) => entry.trim()).filter((entry) => entry.startsWith('DNS:')).map((entry) => entry.slice(4));

export function certificateProblems(certificate: IssuedCertificate, zone: string, now: Date): string[] {
  const problems: string[] = [];
  const wildcard = checkWildcardIn(zone);
  if (certificate.names.length !== 1 || certificate.names[0] !== wildcard) problems.push(`it names ${certificate.names.join(', ') || 'nothing'}, not only ${wildcard}`);
  if (!certificate.issuer.includes('(STAGING)')) problems.push(`its issuer (${certificate.issuer}) is not Let's Encrypt's staging service`);
  if (certificate.validTo.getTime() <= now.getTime()) problems.push(`it expired ${certificate.validTo.toISOString()}`);
  if (certificate.validFrom.getTime() > now.getTime() + 60 * 60 * 1000) problems.push(`it is not valid until ${certificate.validFrom.toISOString()}`);
  return problems;
}

const bare = (name: string): string => name.toLowerCase().replace(/\.$/, '');

export const challengeLeftovers = (records: readonly DnsRecord[], zone: string): (DnsRecord & { id: string })[] =>
  records.filter((record): record is DnsRecord & { id: string } => record.type === 'TXT' && bare(record.name) === challengeNameIn(zone) && typeof record.id === 'string');

const recordKey = (record: DnsRecord): string => `${record.type} ${bare(record.name)} ${record.content}`;

export function zoneChanges(before: readonly DnsRecord[], after: readonly DnsRecord[]): { added: DnsRecord[]; removed: DnsRecord[] } {
  const was = new Set(before.map(recordKey));
  const is = new Set(after.map(recordKey));
  return { added: after.filter((record) => !was.has(recordKey(record))), removed: before.filter((record) => !is.has(recordKey(record))) };
}

export const caddyEnvLines = (envFile: string): string[] => envFile.split('\n').filter((line) => line.length > 0);

export const secretValuesIn = (envLines: readonly string[]): string[] =>
  envLines.map((line) => line.slice(line.indexOf('=') + 1)).filter((value) => value.length > 0);

export const withoutSecrets = (text: string, secrets: readonly string[]): string =>
  secrets.reduce((said, secret) => said.split(secret).join('[hidden]'), text);
