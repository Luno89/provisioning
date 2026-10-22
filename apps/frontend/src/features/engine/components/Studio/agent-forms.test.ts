import { describe, it, expect } from 'vitest'
import type { Agent } from '../../api/agents'
import { onlyToolsChanged } from './agent-forms'

const executor: Agent = {
  slug: 'executor',
  name: 'Executor',
  description: 'Does one task',
  version: '1',
  prompt: 'You do one thing.',
  guidance: '',
  returns: '',
  failures: [],
  procedure: 'do-one-task',
  tools: ['read_file'],
  toolSources: [{ tool: 'read_file', source: 'shipped' }],
  environment: { terminal: true, filesystem: true },
  mine: false,
  usedBy: [],
}

describe('whether only an agent\'s tools changed', () => {
  it('is so when the tools, or only what the server works out, differ', () => {
    expect(onlyToolsChanged(executor, { ...executor, tools: ['read_file', 'browser'] })).toBe(true)
    expect(onlyToolsChanged(executor, { ...executor, mine: true, usedBy: [{ kind: 'chat', by: 'x' }], image: { state: 'ready', reference: 'r' } })).toBe(true)
  })

  it('is not once anything it is set up with changes', () => {
    expect(onlyToolsChanged(executor, { ...executor, prompt: 'You do two things.' })).toBe(false)
    expect(onlyToolsChanged(executor, { ...executor, environment: { terminal: true } })).toBe(false)
    expect(onlyToolsChanged(executor, { ...executor, maxEffect: 'read' })).toBe(false)
  })
})
