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

export const upgradeReports = (from: string, to: string): Report[] => [
  { status: 'installing', detail: `Upgrading from ${from} to ${to}` },
  { status: 'ready', detail: `Upgraded to ${to}` },
];

export const failedUpgradeReports = (from: string, to: string): Report[] => [
  { status: 'installing', detail: `Upgrading from ${from} to ${to}` },
  { status: 'failed', detail: `The upgrade to ${to} failed, so it was rolled back to ${from}` },
];

export function endsWith(trail: Report[], wanted: Report[]): boolean {
  if (wanted.length > trail.length) return false;
  const tail = trail.slice(trail.length - wanted.length);
  return wanted.every((report, index) => tail[index]?.status === report.status && tail[index]?.detail === report.detail);
}

export const inFlightRefusal = (running: number): string =>
  `${running} workflow(s) are running. Wait, or re-run with --force (costs them one retry attempt).`;

export function revisionRunning(history: Array<{ revision: number; values: { image?: { tag?: string } } }>, tag: string): number | undefined {
  return [...history].reverse().find((entry) => entry.values.image?.tag === tag)?.revision;
}
