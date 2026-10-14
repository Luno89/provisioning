import { describe, it, expect } from 'vitest'
import { versionLabel } from './tree-version'

const types = [{ id: 'odoo-addons', versions: { of: 'Odoo', choices: [{ version: '20', language: 'odoo-20' as const }], default: '20' } }, { id: 'api-service' }]

describe('a tree\'s version, as a person reads it', () => {
  it('names what it is a version of', () => {
    expect(versionLabel({ type: 'odoo-addons', version: '20' }, types)).toBe('Odoo 20')
  })

  it('says nothing for a type without versions, or a tree without one', () => {
    expect(versionLabel({ type: 'api-service', version: '20' }, types)).toBeUndefined()
    expect(versionLabel({ type: 'odoo-addons' }, types)).toBeUndefined()
  })
})
