import { describe, it, expect } from 'vitest'
import { checkKind, matchesFilter } from './check-kind'

describe('what kind of check a scenario is', () => {
  it('is a step when it checks one node, a flow when stages follow, and a run otherwise', () => {
    expect(checkKind({ step: { node: 'call-tool' } })).toEqual({ level: 'step', model: 'none' })
    expect(checkKind({ step: { node: 'decide' }, script: { rules: [] } })).toEqual({ level: 'step', model: 'script' })
    expect(checkKind({ then: [{ name: 'later', do: { waitQuiet: true } }], script: { rules: [] } })).toEqual({ level: 'flow', model: 'script' })
    expect(checkKind({})).toEqual({ level: 'run', model: 'yours' })
  })

  it('filters by level and by who plays the model', () => {
    const kind = { level: 'flow' as const, model: 'script' as const }
    expect(matchesFilter(kind, {})).toBe(true)
    expect(matchesFilter(kind, { level: 'flow', model: 'script' })).toBe(true)
    expect(matchesFilter(kind, { model: 'yours' })).toBe(false)
  })
})
