import { describe, it, expect } from 'vitest'
import { primaryInput, type EngineAgent } from './engine'

const agent = (over: Partial<EngineAgent>): EngineAgent => ({
  slug: 'koala',
  name: 'Koala',
  description: '',
  loop: 'interactive-chat',
  tools: [],
  canDelegateTo: [],
  inputs: null,
  mine: false,
  ...over,
})

describe('primaryInput', () => {
  it('asks for a goal when that is what the agent needs', () => {
    const delivery = agent({
      slug: 'delivery',
      inputs: { type: 'object', properties: { goal: { type: 'string' } }, required: ['goal'] },
    })

    expect(primaryInput(delivery)).toEqual({ field: 'goal', label: 'What do you want built?' })
  })

  it('asks a research agent for a question instead', () => {
    const research = agent({
      slug: 'research',
      inputs: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
    })

    expect(primaryInput(research)).toMatchObject({ field: 'question' })
    expect(primaryInput(research).label).toContain('know')
  })

  it('prefers the required field over whatever happens to be first', () => {
    const odd = agent({
      inputs: {
        type: 'object',
        properties: { context: { type: 'string' }, task: { type: 'string' } },
        required: ['task'],
      },
    })

    expect(primaryInput(odd).field).toBe('task')
  })

  it('falls back to the first declared property when nothing is required', () => {
    const loose = agent({ inputs: { type: 'object', properties: { note: { type: 'string' } } } })

    expect(primaryInput(loose)).toEqual({ field: 'note', label: 'note?' })
  })

  it('falls back to a plain message when an agent declares no inputs', () => {
    expect(primaryInput(agent({ inputs: null }))).toEqual({
      field: 'message',
      label: 'What do you want it to do?',
    })
  })

  it('survives no agent being selected yet', () => {
    expect(primaryInput(undefined).field).toBe('message')
  })
})
