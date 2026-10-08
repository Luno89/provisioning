import { describe, it, expect } from 'vitest'
import { describeUsage, groupAgents, groupOf } from './agent-groups'

const agent = (slug: string, usedBy: { kind: 'chat' | 'platform' | 'tree-type' | 'procedure' | 'hand-off'; by: string }[] = []) => ({ slug, name: slug.toUpperCase(), usedBy })

describe('grouping agents by how they are used', () => {
  it('puts each agent under the most direct way it is used', () => {
    expect(groupOf(agent('agent-builder', [{ kind: 'platform', by: 'x' }, { kind: 'chat', by: 'y' }]))).toBe('chat')
    expect(groupOf(agent('planner', [{ kind: 'hand-off', by: 'koala' }, { kind: 'procedure', by: 'delivery' }]))).toBe('procedure')
    expect(groupOf(agent('mine'))).toBe('unused')
  })

  it('lists the groups in order, leaves out empty ones, sorts the agents and filters by name', () => {
    const agents = [agent('research', [{ kind: 'hand-off', by: 'koala' }]), agent('koala', [{ kind: 'chat', by: 'every new conversation' }]), agent('mine')]
    expect(groupAgents(agents).map((group) => [group.title, group.agents.map((one) => one.slug)])).toEqual([
      ['You talk to', ['koala']],
      ['Handed work by other agents', ['research']],
      ['Not used yet', ['mine']],
    ])
    expect(groupAgents(agents, 'RES').map((group) => group.agents.map((one) => one.slug))).toEqual([['research']])
  })

  it('says each use in plain words', () => {
    expect(describeUsage({ kind: 'tree-type', by: 'Default' })).toBe('grows Default trees')
    expect(describeUsage({ kind: 'hand-off', by: 'koala' })).toBe('handed work by koala')
  })
})
