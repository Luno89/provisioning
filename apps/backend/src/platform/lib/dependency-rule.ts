export interface Vulnerability {
  id: string;
  name: string;
  version: string;
  fixed: string[];
}

export const COOLING_OFF_DAYS = 14;

export const DAY_MS = 24 * 60 * 60 * 1000;

const releaseParts = (version: string): number[] => (version.split(/[-+]/)[0] ?? '').split('.').map((part) => Number.parseInt(part, 10) || 0);

export function compareVersions(a: string, b: string): number {
  const left = releaseParts(a);
  const right = releaseParts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export const fixOf = (vulnerability: Vulnerability): string | undefined =>
  vulnerability.fixed.filter((version) => compareVersions(version, vulnerability.version) > 0).sort(compareVersions)[0];

export interface JudgedVulnerability {
  vulnerability: Vulnerability;
  fix?: string | undefined;
  publishedAt?: string | undefined;
  takeOn?: string | undefined;
}

export function judgeVulnerabilities(
  found: readonly Vulnerability[],
  publishedAt: (name: string, version: string) => string | undefined,
  now: Date,
  days = COOLING_OFF_DAYS,
): { due: JudgedVulnerability[]; waiting: JudgedVulnerability[] } {
  const due: JudgedVulnerability[] = [];
  const waiting: JudgedVulnerability[] = [];
  for (const vulnerability of found) {
    const fix = fixOf(vulnerability);
    const published = fix ? publishedAt(vulnerability.name, fix) : undefined;
    const takeOn = published ? new Date(Date.parse(published) + days * DAY_MS) : undefined;
    const judged = { vulnerability, fix, publishedAt: published, takeOn: takeOn?.toISOString().slice(0, 10) };
    if (takeOn && takeOn.getTime() > now.getTime()) waiting.push(judged);
    else due.push(judged);
  }
  return { due, waiting };
}
