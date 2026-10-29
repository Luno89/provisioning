import { describe, expect, it } from 'vitest'
import { ageOf, componentMatches, countsByState, findingMatches, releaseSummary, sortedFindings } from './dependency-view'
import type { DependencyFinding, ListedComponent } from '../api/dependencies'

const finding = (name: string, state: DependencyFinding['state'], severity?: DependencyFinding['advisory']['severity']): DependencyFinding => ({
  key: name, component: { name, version: '1.0.0', kind: 'npm', in: 'koala' }, advisory: { id: `GHSA-${name}`, ...(severity ? { severity } : {}) },
  state, releases: ['v2026.10.29'], instances: ['luno'], firstSeenAt: '2026-10-29T00:00:00Z',
})

describe('reading the dependency findings', () => {
  it('puts what is due first, then the worst, then by name, and counts each state', () => {
    const findings = [finding('b', 'waiting', 'critical'), finding('a', 'no-fix'), finding('c', 'due', 'low'), finding('d', 'due', 'high')]
    expect(sortedFindings(findings).map((entry) => entry.component.name)).toEqual(['d', 'c', 'b', 'a'])
    expect(countsByState(findings)).toEqual({ due: 2, waiting: 1, 'no-fix': 1 })
  })

  it('filters by state and by any word in the package, advisory, release or instance', () => {
    expect(findingMatches(finding('seroval', 'due'), 'GHSA-SER', 'all')).toBe(true)
    expect(findingMatches(finding('seroval', 'due'), 'luno', 'due')).toBe(true)
    expect(findingMatches(finding('seroval', 'due'), '', 'waiting')).toBe(false)
    expect(findingMatches(finding('seroval', 'due'), 'k3s', 'all')).toBe(false)
  })

  it('lists components by kind, leaving development-only packages out unless asked', () => {
    const dev: ListedComponent = { name: 'vite', version: '8.0.16', kind: 'npm', dev: true, checked: true }
    expect(componentMatches(dev, '', 'all', false)).toBe(false)
    expect(componentMatches(dev, 'vite', 'npm', true)).toBe(true)
    expect(componentMatches(dev, '', 'image', true)).toBe(false)
  })

  it('says how old a version is in plain words', () => {
    const now = new Date('2026-10-29T12:00:00Z')
    expect(ageOf(undefined, now)).toBeUndefined()
    expect(ageOf('2026-10-29T08:00:00Z', now)).toBe('today')
    expect(ageOf('2026-10-28T08:00:00Z', now)).toBe('1 day old')
    expect(ageOf('2026-06-01T00:00:00Z', now)).toBe('5 months old')
    expect(ageOf('2023-06-01T00:00:00Z', now)).toBe('3 years old')
  })

  it('tells an instance owner what their release carries and what fixes it', () => {
    const one = { component: { name: 'seroval', version: '1.6.7', kind: 'npm' as const }, advisory: { id: 'GHSA-x' }, state: 'due' as const }
    expect(releaseSummary('v2026.10.23', [])).toBeUndefined()
    expect(releaseSummary('v2026.10.23', [{ ...one, fixedBy: 'v2026.10.29' }])).toBe('Your release, v2026.10.23, has 1 known advisory; v2026.10.29 fixes it.')
    expect(releaseSummary('v2026.10.23', [{ ...one, fixedBy: 'v2026.10.29' }, one])).toBe('Your release, v2026.10.23, has 2 known advisories; v2026.10.29 fixes 1 of them.')
    expect(releaseSummary(undefined, [one])).toBe('Your release has 1 known advisory; no newer release fixes them yet.')
  })
})
