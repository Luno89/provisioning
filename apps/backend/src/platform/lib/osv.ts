import { osvVersion, type InventoryComponent } from './sbom.js';

export const OSV_API = 'https://api.osv.dev/v1';

export const OSV_BATCH = 1000;

export type Severity = 'critical' | 'high' | 'moderate' | 'low';

export interface OsvQuery {
  package: { ecosystem: string; name: string };
  version: string;
}

export interface OsvAdvisory {
  id: string;
  summary?: string | undefined;
  severity?: Severity | undefined;
  fixed: string[];
}

export const queryOf = (component: InventoryComponent): OsvQuery =>
  ({ package: { ecosystem: component.ecosystem!, name: component.osvName! }, version: osvVersion(component) });

export const queryKey = (query: OsvQuery): string => `${query.package.ecosystem}|${query.package.name}|${query.version}`;

export function batches<T>(items: readonly T[], size = OSV_BATCH): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size));
  return out;
}

export function idsFromBatch(answer: unknown, asked: number): string[][] {
  const results = (answer as { results?: { vulns?: { id?: unknown }[] }[] } | undefined)?.results;
  if (!Array.isArray(results) || results.length !== asked) throw new Error(`OSV answered ${Array.isArray(results) ? results.length : 'no'} results for ${asked} queries`);
  return results.map((result) => (result.vulns ?? []).flatMap((vuln) => (typeof vuln.id === 'string' ? [vuln.id] : [])));
}

const SEVERITIES: Record<string, Severity> = { CRITICAL: 'critical', HIGH: 'high', MODERATE: 'moderate', MEDIUM: 'moderate', LOW: 'low' };

interface OsvRecord {
  id?: unknown;
  summary?: unknown;
  database_specific?: { severity?: unknown };
  affected?: { package?: { ecosystem?: unknown; name?: unknown }; ranges?: { events?: { fixed?: unknown }[] }[]; database_specific?: { severity?: unknown } }[];
}

export function advisoryFor(record: unknown, query: OsvQuery): OsvAdvisory | undefined {
  const advisory = record as OsvRecord;
  if (typeof advisory.id !== 'string') return undefined;
  const affected = (advisory.affected ?? []).filter((entry) => entry.package?.ecosystem === query.package.ecosystem && entry.package?.name === query.package.name);
  const fixed = affected.flatMap((entry) => entry.ranges ?? []).flatMap((range) => range.events ?? []).flatMap((event) => (typeof event.fixed === 'string' ? [event.fixed] : []));
  const rated = [advisory.database_specific?.severity, ...affected.map((entry) => entry.database_specific?.severity)].find((value) => typeof value === 'string');
  return {
    id: advisory.id,
    ...(typeof advisory.summary === 'string' ? { summary: advisory.summary } : {}),
    ...(typeof rated === 'string' && SEVERITIES[rated.toUpperCase()] ? { severity: SEVERITIES[rated.toUpperCase()] } : {}),
    fixed,
  };
}
