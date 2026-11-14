import { describe, expect, it } from 'vitest'
import { ageOf, buildLine, goneLine, componentMatches, countsByState, findingMatches, releaseSummary, sortedFindings } from './dependency-view'
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

describe('a newer build of a moving tag', () => {
  const build = { image: 'theroyallab/tabbyapi', tag: 'latest', pinned: 'a'.repeat(64), digest: 'b'.repeat(64), builtAt: '2026-11-12T20:00:00Z', revision: 'c0ffee1234', firstSeenAt: '2026-11-13T12:00:00.000Z', takeOn: '2026-11-27' }

  it('says when it was built, from which commit, and when it can be taken', () => {
    expect(buildLine(build, new Date('2026-11-20T00:00:00Z'))).toBe('theroyallab/tabbyapi:latest now names sha256:bbbbbbbbbbbb, built 2026-11-12 from c0ffee1, first seen 2026-11-13. It can be taken on 2026-11-27.')
  })

  it('says it can be taken now, by pinning its digest, once two weeks have passed since it was first seen', () => {
    expect(buildLine({ ...build, builtAt: undefined, revision: undefined }, new Date('2026-11-27T00:00:00Z'))).toBe('theroyallab/tabbyapi:latest now names sha256:bbbbbbbbbbbb, first seen 2026-11-13. Take it by pinning that digest in dependencies.pins.json.')
  })
})

describe('a pinned digest gone upstream', () => {
  it('says which digest is gone, since when, from where, and what it means for a deploy', () => {
    expect(goneLine({ image: 'vllm/vllm-openai', source: 'docker.io/vllm/vllm-openai:v0.32.0', digest: 'd'.repeat(64), since: '2026-11-14T06:00:00.000Z', releases: ['v2026.11.13', 'v2026.11.14'] }))
      .toBe('vllm/vllm-openai@sha256:dddddddddddd is gone upstream since 2026-11-14: docker.io no longer has the digest v2026.11.13, v2026.11.14 pin, so a machine that has not pulled it already cannot deploy it.')
    expect(goneLine({ image: 'theroyallab/tabbyapi', source: `ghcr.io/theroyallab/tabbyapi@sha256:${'c'.repeat(64)}`, digest: 'c'.repeat(64), since: '2026-11-14T06:00:00.000Z', releases: ['v2026.11.13'] }))
      .toBe('theroyallab/tabbyapi@sha256:cccccccccccc is gone upstream since 2026-11-14: ghcr.io no longer has the digest v2026.11.13 pins, so a machine that has not pulled it already cannot deploy it.')
  })
})
