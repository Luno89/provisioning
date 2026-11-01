import { UPGRADE_WORDS } from '../../apps/backend/src/instances/lib/self-upgrade.js';

export const imageTagOf = (commit: string): string => commit.slice(0, 12);

export const labHostsLine = (domain: string, address: string): string => `${address} app.${domain} mesh.${domain}`;

export const labDnsmasq = (domain: string, address: string): string =>
  ['bind-interfaces', `listen-address=${address},127.0.0.1`, `address=/${domain}/${address}`, ''].join('\n');

export interface Report { status: string; detail?: string | undefined }

export function noted(trail: Report[], next: Report): Report[] {
  const last = trail[trail.length - 1];
  if (last && last.status === next.status && last.detail === next.detail) return trail;
  return [...trail, { status: next.status, detail: next.detail }];
}

export interface Expected { status: string; detail: string; why?: true }

export const upgradeReports = (from: string, to: string): Expected[] => [
  { status: 'installing', detail: UPGRADE_WORDS.upgrading(from, to) },
  { status: 'ready', detail: UPGRADE_WORDS.upgraded(to) },
];

export const failedUpgradeReports = (from: string, to: string): Expected[] => [
  { status: 'installing', detail: UPGRADE_WORDS.upgrading(from, to) },
  { status: 'failed', detail: UPGRADE_WORDS.rolledBack(to, from), why: true },
];

export function endsWith(trail: Report[], wanted: Expected[]): boolean {
  if (wanted.length > trail.length) return false;
  const tail = trail.slice(trail.length - wanted.length);
  return wanted.every((report, index) => tail[index]?.status === report.status
    && (report.why ? (tail[index]?.detail ?? '').startsWith(`${report.detail}: `) : tail[index]?.detail === report.detail));
}

export const unsignedRefusal = (tag: string, signers: string): string => `Refusing ${tag}: root moves only onto a release signed by a key in ${signers}`;

export const inFlightRefusal = (running: number): string =>
  `${running} workflow(s) are running. Wait, or re-run with --force (costs them one retry attempt).`;

export function revisionRunning(history: Array<{ revision: number; values: { image?: { tag?: string } } }>, tag: string): number | undefined {
  return [...history].reverse().find((entry) => entry.values.image?.tag === tag)?.revision;
}

export interface UnhostableRelease { tag: string; why: string }

export const UNHOSTABLE_RELEASES: readonly UnhostableRelease[] = [
  { tag: 'v2026.10.23', why: 'its Temporal health check dials the Docker gateway, which a hardened root no longer publishes on' },
];

export const unhostable = (tag: string): UnhostableRelease | undefined => UNHOSTABLE_RELEASES.find((release) => release.tag === tag);

export const STAND_IN_REF = 'v2099.12.29';
