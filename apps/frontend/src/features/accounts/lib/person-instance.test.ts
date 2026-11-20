import { describe, expect, it } from 'vitest'
import { instanceLine } from './person-instance'

describe('a person\'s instance in People', () => {
  it('says when root cannot reach it', () => {
    const base = { name: 'bob', status: 'ready' as const, url: 'https://bob.koala.dev', autoUpdates: true }
    expect(instanceLine(base)).toBe('bob on their own machine: running, updates automatically')
    expect(instanceLine({ name: 'cy', status: 'ready', url: 'https://cy.koala.dev', version: 'v2026.11.17', heldByData: { version: 'v2026.10.30', needs: 1 } })).toBe('cy on their own machine: running v2026.11.17 (held: its data cannot run on v2026.10.30)')
    expect(instanceLine({ ...base, unreachableSince: '2026-10-29T10:00:00.000Z' })).toMatch(/^bob on their own machine: running, not answering since .*2026, updates automatically$/)
  })

  it('says since when signing out has not reached it, and why', () => {
    const base = { name: 'bob', status: 'ready' as const, url: 'https://bob.koala.dev', autoUpdates: true }
    expect(instanceLine({ ...base, signOutsUndelivered: { since: '2026-11-08T10:00:00.000Z', why: 'it answered 502' } }))
      .toMatch(/^bob on their own machine: running, signing out has not reached it since .*2026 \(it answered 502\), updates automatically$/)
  })
})

describe('an instance in root\'s People', () => {
  it('marks a release root withdrew', () => {
    expect(instanceLine({ name: 'cy', status: 'ready', url: 'https://cy.koala.dev', version: 'v2026.10.26', versionWithdrawn: true, autoUpdates: false }))
      .toBe('cy on their own machine: running v2026.10.26 (withdrawn), updates by hand')
    expect(instanceLine({ name: 'cy', status: 'ready', url: 'https://cy.koala.dev', version: 'v2026.10.25', autoUpdates: true }))
      .toBe('cy on their own machine: running v2026.10.25, updates automatically')
  })
})
