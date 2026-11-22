export const AUDITS_DIR = 'tests/audits';
export const FAILURES_FILE = 'tests/test-failures.json';
export const AUDIT_AFTER = 2;

export interface Failure {
  at: string;
  why?: string;
}

export type Failures = Record<string, Failure[]>;

export const auditFileOf = (name: string): string => `${AUDITS_DIR}/${name.replace(/^tests\//, '').replace(/[^A-Za-z0-9.-]+/g, '_')}.md`;

export function withFailure(failures: Failures, name: string, failure: Failure): Failures {
  return { ...failures, [name]: [...(failures[name] ?? []), failure] };
}

export function auditOwed(failed: readonly Failure[], auditedAt: string | undefined): boolean {
  const since = auditedAt ? failed.filter(({ at }) => Date.parse(at) > Date.parse(auditedAt)) : failed;
  return since.length >= AUDIT_AFTER;
}

export function owedAudits(failures: Failures, auditedAt: (name: string) => string | undefined): string[] {
  return Object.entries(failures).filter(([name, failed]) => auditOwed(failed, auditedAt(name))).map(([name]) => name).sort();
}

export function auditRefusal(owed: readonly string[]): string | undefined {
  if (owed.length === 0) return undefined;
  return `${owed.length === 1 ? 'this has' : 'these have'} failed ${AUDIT_AFTER} times since ${owed.length === 1 ? 'its' : 'their'} last audit, and a test that fails twice means the code under it is unreliable: ${owed.join(', ')}. Audit the code (races, polling, timers, shared state, unawaited work), research how it should be built, fix it, and commit what you found as ${owed.map(auditFileOf).join(', ')} with the fix.`;
}
