import { describe, it, expect } from 'vitest'
import { BUILT_IN_DEFINITIONS, createNodeCatalogue } from '@koala/agent-engine/procedure'
import { stepCheckFrom } from './step-check-draft'

const catalogue = createNodeCatalogue([...BUILT_IN_DEFINITIONS])

describe('turning a step of a real run into a check', () => {
  it('keeps the node, its settings and the inputs it was given, leaves out what the check supplies, and expects the exit it took', () => {
    const scenario = stepCheckFrom({
      trace: { node: 'verdict', kind: 'decide', role: 'step', exit: 'yes', inputs: { text: 'It is done.', binding: { providerId: 'tabby' } }, outputs: { decision: 'yes' } },
      settings: { question: 'Is it done?' },
      agent: 'judge',
      message: 'Judge this.',
      procedure: 'judge-a-leaf',
      catalogue,
      now: 1_000,
    })

    expect(scenario).toEqual({
      id: 'step-decide-rs',
      name: 'Decide as it ran at verdict',
      describe: 'Step: the Decide node "verdict" given the inputs it had in a real run, expected to do what it did then.',
      agent: 'judge',
      procedure: { id: 'step-check-step-decide-rs' },
      step: { node: 'decide', settings: { question: 'Is it done?' }, inputs: { text: 'It is done.' }, from: 'judge-a-leaf' },
      input: { message: 'Judge this.' },
      expect: { exit: 'yes' },
    })
  })

  it('expects a value node to produce what it produced then', () => {
    const scenario = stepCheckFrom({ trace: { node: 'greeting', kind: 'text', role: 'value', inputs: {}, outputs: { text: 'hello' } }, settings: { text: 'hello' }, agent: 'koala', message: '', procedure: 'greet', catalogue, now: 1 })
    expect(scenario.expect).toEqual({ outputs: { text: { equals: 'hello' } } })
  })
})
