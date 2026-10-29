import type { DependencyFinding, FindingState, ListedComponent, ReleaseFinding, Severity } from '../api/dependencies'

const STATE_ORDER: Record<FindingState, number> = { due: 0, waiting: 1, 'no-fix': 2 }
const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, moderate: 2, low: 3 }

export const STATE_LABEL: Record<FindingState, string> = { due: 'Update due', waiting: 'Fix waiting', 'no-fix': 'No fix yet' }

export function sortedFindings<T extends Pick<DependencyFinding, 'state' | 'advisory' | 'component'>>(findings: readonly T[]): T[] {
  return [...findings].sort((a, b) =>
    STATE_ORDER[a.state] - STATE_ORDER[b.state]
    || (SEVERITY_ORDER[a.advisory.severity ?? 'low'] ?? 3) - (SEVERITY_ORDER[b.advisory.severity ?? 'low'] ?? 3)
    || a.component.name.localeCompare(b.component.name))
}

export const countsByState = (findings: readonly Pick<DependencyFinding, 'state'>[]): Record<FindingState, number> =>
  findings.reduce((counts, finding) => ({ ...counts, [finding.state]: counts[finding.state] + 1 }), { due: 0, waiting: 0, 'no-fix': 0 } as Record<FindingState, number>)

const text = (words: string): string => words.trim().toLowerCase()

export function findingMatches(finding: DependencyFinding, query: string, state: FindingState | 'all'): boolean {
  if (state !== 'all' && finding.state !== state) return false
  const wanted = text(query)
  if (!wanted) return true
  return [finding.component.name, finding.component.version, finding.advisory.id, finding.advisory.summary ?? '', ...finding.releases, ...finding.instances]
    .some((field) => field.toLowerCase().includes(wanted))
}

export function componentMatches(component: ListedComponent, query: string, kind: ListedComponent['kind'] | 'all', withDev: boolean): boolean {
  if (kind !== 'all' && component.kind !== kind) return false
  if (!withDev && component.dev) return false
  const wanted = text(query)
  return !wanted || `${component.name} ${component.version ?? ''} ${component.where ?? ''}`.toLowerCase().includes(wanted)
}

export function ageOf(publishedAt: string | undefined, now: Date): string | undefined {
  if (!publishedAt) return undefined
  const days = Math.floor((now.getTime() - Date.parse(publishedAt)) / 86_400_000)
  if (days < 1) return 'today'
  if (days < 60) return `${days} day${days === 1 ? '' : 's'} old`
  const months = Math.floor(days / 30)
  return months < 24 ? `${months} months old` : `${Math.floor(days / 365)} years old`
}

export function releaseSummary(release: string | undefined, findings: readonly ReleaseFinding[]): string | undefined {
  if (findings.length === 0) return undefined
  const fixedBy = [...new Set(findings.flatMap((finding) => (finding.fixedBy ? [finding.fixedBy] : [])))]
  const own = release ? `Your release, ${release}, has` : 'Your release has'
  const head = `${own} ${findings.length} known advisor${findings.length === 1 ? 'y' : 'ies'}`
  if (fixedBy.length === 0) return `${head}; no newer release fixes them yet.`
  const fixed = findings.filter((finding) => finding.fixedBy).length
  return `${head}; ${fixedBy.at(-1)} fixes ${fixed === findings.length ? (findings.length === 1 ? 'it' : 'all of them') : `${fixed} of them`}.`
}
