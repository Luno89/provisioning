import { describe, expect, it } from 'vitest'
import { PROCEDURE_SCHEMA, type GroupDefinition, type Procedure } from '@koala/agent-engine/procedure'
import { adoptPublished, draftNewVersion, draftOf, operationName, publishedName } from './published-groups'

const group = (id: string): GroupDefinition => ({
  id, title: 'Shout', describe: 'louder', inputs: [], outputs: [], exits: [{ name: 'done', describe: 'said', from: { node: 'say', exit: 'true' } }],
  start: 'say', nodes: [{ id: 'say', kind: 'condition', settings: { expression: 'true' }, position: { x: 0, y: 0 } }], wires: [], flow: [],
})

const using = (groupId: string, groups: GroupDefinition[] = []): Procedure => ({
  schema: PROCEDURE_SCHEMA, id: 'greeter', version: '1', name: 'Greeter', describe: '', budget: {}, start: 'shout',
  nodes: [{ id: 'shout', kind: 'group', group: groupId, settings: {}, position: { x: 0, y: 0 } }],
  wires: [], flow: [],
  groups: [...groups, { ...group('wrapper'), nodes: [{ id: 'inner', kind: 'group', group: groupId, settings: {}, position: { x: 0, y: 0 } }] }],
})

describe('published groups', () => {
  it('reads an operation\'s extension, name and version from its id, and only from a published one', () => {
    expect(publishedName('loud.shout@3')).toEqual({ extension: 'loud', name: 'shout', version: 3 })
    expect(publishedName('tool-loop')).toBeUndefined()
    expect(publishedName('loud.shout')).toBeUndefined()
    expect(draftOf('loud.shout')).toEqual({ extension: 'loud', name: 'shout' })
    expect(draftOf('my-group')).toBeUndefined()
  })

  it('names an operation after its title', () => {
    expect(operationName('Shout It, Loudly!')).toBe('shout-it-loudly')
    expect(operationName('2 fast')).toBe('fast')
  })

  it('drafts a new version as a local copy, pointing every use at the copy so it can be edited', () => {
    const drafted = draftNewVersion(using('loud.shout@2'), group('loud.shout@2'))
    if ('refused' in drafted) throw new Error(drafted.refused)

    expect(drafted.draftId).toBe('loud.shout')
    expect(drafted.procedure.groups.map((entry) => entry.id)).toEqual(['wrapper', 'loud.shout'])
    expect(drafted.procedure.nodes[0]?.group).toBe('loud.shout')
    expect(drafted.procedure.groups[0]?.nodes[0]?.group).toBe('loud.shout')
    expect(draftNewVersion(drafted.procedure, group('loud.shout@2'))).toEqual({ refused: 'a new version of Shout is already being drafted here' })
  })

  it('swaps a local group for the operation it was published as, dropping the local copy', () => {
    const adopted = adoptPublished(using('loud.shout', [group('loud.shout')]), 'loud.shout', 'loud.shout@3')

    expect(adopted.groups.map((entry) => entry.id)).toEqual(['wrapper'])
    expect(adopted.nodes[0]?.group).toBe('loud.shout@3')
    expect(adopted.groups[0]?.nodes[0]?.group).toBe('loud.shout@3')
  })
})
