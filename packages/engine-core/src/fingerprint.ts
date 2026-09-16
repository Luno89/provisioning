import { createHash } from 'crypto';
import type { EnvironmentSpec } from './environment.js';

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, stable(v)]),
    );
  }
  return value;
}

export function specFingerprint(spec: EnvironmentSpec): string {
  const normalised = stable({
    kind: spec.kind,
    languages: [...(spec.languages ?? [])].sort(),
    packages: [...(spec.packages ?? [])].sort(),
    egress: spec.egress !== false,
    egressAllowlist: [...(spec.egressAllowlist ?? [])].sort(),
    env: spec.env ?? {},
  });

  return createHash('sha256').update(JSON.stringify(normalised)).digest('hex').slice(0, 32);
}
