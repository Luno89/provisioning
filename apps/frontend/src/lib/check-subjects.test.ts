import { describe, it, expect } from 'vitest'
import { scenarioSubjects, within } from './check-subjects'
import type { Scenario } from '../api/evals'

const base: Scenario = { id: 's', name: 'S', describe: '', agent: 'koala', procedure: { id: 'tool-rounds' }, input: { message: 'hi' }, expect: {} }

describe('where a check belongs', () => {
  it('belongs to its agent, the agents it must hand off to, its procedure and every tool it expects, through every stage', () => {
    expect(scenarioSubjects({
      ...base,
      expect: { toolsCalled: ['research'], toolsNotCalled: ['delete_file'], handOffs: [{ agent: 'research' }] },
      then: [{ name: 'later', do: { chat: 'and?' }, expect: { toolsSucceeded: ['write_file'], provokes: { tool: 'read_file', when: 'x', then: 'retried' } } }],
    })).toEqual({ agents: ['koala', 'research'], procedures: ['tool-rounds'], tools: ['delete_file', 'read_file', 'research', 'write_file'] })
  })

  it('belongs to the tool a step check calls and the procedure it was taken from, not the one made up to run it', () => {
    expect(scenarioSubjects({ ...base, procedure: { id: 'step-check-s' }, step: { node: 'call-tool', settings: { tool: 'write_file' } } }))
      .toEqual({ agents: ['koala'], procedures: [], tools: ['write_file'] })
    expect(scenarioSubjects({ ...base, procedure: { id: 'step-check-s' }, step: { node: 'decide', from: 'tool-rounds' } }).procedures).toEqual(['tool-rounds'])
  })

  it('places a turn check under its agent and the tool it must choose, never under the procedure made to run it', () => {
    const subjects = scenarioSubjects({ ...base, agent: 'agent-builder', procedure: { id: 'turn-check' }, turn: true, expect: { chooses: { tool: 'list_references' } } })
    expect(within(subjects, { agent: 'agent-builder' })).toBe(true)
    expect(within(subjects, { tool: 'list_references' })).toBe(true)
    expect(within(subjects, { tool: 'read_procedure' })).toBe(false)
    expect(within(subjects, { procedure: 'tool-rounds' })).toBe(false)
  })
})

describe('a new check started on a page', () => {
  it('starts as a check of what the page is about', async () => {
    const { scopedDraft } = await import('./scenario-draft')
    expect(scopedDraft({ agent: 'research' }, 'koala').agent).toBe('research')
    expect(scopedDraft({ procedure: 'tool-rounds' }, 'koala')).toMatchObject({ agent: 'koala', procedure: 'tool-rounds' })
    expect(JSON.parse(scopedDraft({ tool: 'write_file' }, 'koala').step)).toEqual({ node: 'call-tool', settings: { tool: 'write_file' } })
  })
})
