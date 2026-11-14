import { describe, expect, it } from 'vitest'
import { toolCallingOf } from './vllm-tool-calling'

describe('what the person sees about vLLM\'s tool calling', () => {
  it('shows the parser Koala chose from the model, and says how it chose it', () => {
    expect(toolCallingOf('Qwen/Qwen3-8B', true, '', { pick: { parser: 'hermes', from: 'template' } })).toEqual({ enabled: true, parser: 'hermes', fromModel: 'Chosen from its chat template: hermes' })
    expect(toolCallingOf('mistralai/Small', true, '', { pick: { parser: 'mistral', from: 'name' } })).toEqual({ enabled: true, parser: 'mistral', fromModel: 'Chosen from its name: mistral' })
  })

  it('takes the parser the person picked over the one chosen', () => {
    expect(toolCallingOf('Qwen/Qwen3-8B', true, 'pythonic', { pick: { parser: 'hermes', from: 'template' } })).toEqual({ enabled: true, parser: 'pythonic', fromModel: 'Chosen from its chat template: hermes' })
    expect(toolCallingOf('someone/their-own-model', true, 'mistral', { pick: { problem: 'pick one' } })).toEqual({ enabled: true, parser: 'mistral' })
  })

  it('says why Koala could not choose one, from its answer or from the request that failed', () => {
    expect(toolCallingOf('someone/their-own-model', true, '', { pick: { problem: 'its chat template has no tool call format Koala knows' } })).toEqual({ enabled: true, problem: 'its chat template has no tool call format Koala knows' })
    expect(toolCallingOf('a/down', true, '', { error: 'Hugging Face did not answer' })).toEqual({ enabled: true, problem: 'Hugging Face did not answer' })
  })

  it('waits while the template is read, and asks for a model when none is typed', () => {
    expect(toolCallingOf('a/reading', true, '', {})).toEqual({ enabled: true, waiting: 'Koala is reading a/reading\'s chat template to choose its parser' })
    expect(toolCallingOf('  ', true, '', {})).toEqual({ enabled: true, problem: 'Type the model, so Koala can read its chat template' })
  })

  it('is off when the person turned it off', () => {
    expect(toolCallingOf('Qwen/Qwen3-8B', false, 'hermes', { pick: { parser: 'hermes', from: 'template' } })).toEqual({ enabled: false })
  })
})
