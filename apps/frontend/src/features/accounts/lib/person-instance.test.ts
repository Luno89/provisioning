import { describe, expect, it } from 'vitest'
import { instanceLine } from './person-instance'

describe('an instance in root\'s People', () => {
  it('marks a release root withdrew', () => {
    expect(instanceLine({ name: 'cy', where: 'own', status: 'ready', url: 'https://cy.koala.dev', version: 'v2026.10.26', versionWithdrawn: true, autoUpdates: false }))
      .toBe('cy on their own machine: running v2026.10.26 (withdrawn), updates by hand')
    expect(instanceLine({ name: 'cy', where: 'own', status: 'ready', url: 'https://cy.koala.dev', version: 'v2026.10.25', autoUpdates: true }))
      .toBe('cy on their own machine: running v2026.10.25, updates automatically')
  })
})
