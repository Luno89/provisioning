import { describe, it, expect } from 'vitest'
import { groupProcedures, groupTools, groupTreeTypes, procedureGroupOf, runnersOf, toolGroupOf } from './studio-groups'

describe('grouping tools by what they act on', () => {
  it('splits the platform\'s tools by how far they go', () => {
    expect(toolGroupOf({ binding: 'environment', effect: 'write' })).toBe('workspace')
    expect(toolGroupOf({ binding: 'network', effect: 'read' })).toBe('web')
    expect(toolGroupOf({ binding: 'platform', effect: 'read' })).toBe('look')
    expect(toolGroupOf({ binding: 'platform', effect: 'propose' })).toBe('propose')
    expect(toolGroupOf({ binding: 'platform', effect: 'write' })).toBe('change')
    expect(groupTools([{ name: 'write_file', binding: 'environment', effect: 'write' }, { name: 'get_logs', binding: 'platform', effect: 'read' }, { name: 'delete_file', binding: 'environment', effect: 'write' }])
      .map((group) => [group.title, group.items.map((tool) => tool.name)])).toEqual([
      ['Work in the workspace', ['delete_file', 'write_file']],
      ['Look things up', ['get_logs']],
    ])
  })
})

describe('grouping procedures by what runs them', () => {
  const agents = [
    { slug: 'koala', procedure: 'interactive-chat', usedBy: [{ kind: 'chat' as const, by: 'x' }] },
    { slug: 'agent-builder', procedure: 'interactive-chat', usedBy: [{ kind: 'platform' as const, by: 'x' }] },
    { slug: 'planner', procedure: 'planning', usedBy: [{ kind: 'procedure' as const, by: 'delivery' }] },
    { slug: 'spare', procedure: 'tool-rounds', usedBy: [] },
  ]

  it('puts each under the most direct use of the agents that run it', () => {
    expect(procedureGroupOf('interactive-chat', agents)).toBe('chat')
    expect(procedureGroupOf('planning', agents)).toBe('procedure')
    expect(procedureGroupOf('tool-rounds', agents)).toBe('idle')
    expect(procedureGroupOf('ui-shout', agents)).toBe('unused')
    expect(runnersOf('interactive-chat', agents)).toEqual(['agent-builder', 'koala'])
    expect(groupProcedures([{ id: 'ui-shout' }, { id: 'interactive-chat' }], agents).map((group) => group.title)).toEqual(['Run by agents you talk to', 'Not run by any agent'])
  })
})

describe('grouping tree types by what they make', () => {
  it('separates what runs from what is written', () => {
    expect(groupTreeTypes([{ label: 'Research paper', produces: 'artefact' }, { label: 'API', produces: 'service' }]).map((group) => [group.title, group.items.map((type) => type.label)])).toEqual([
      ['Build something that runs', ['API']],
      ['Produce a document or artefact', ['Research paper']],
    ])
  })
})
