import { describe, expect, it } from 'vitest'
import { toolCallingOf, toolCallParserFor, VLLM_TOOL_CALL_PARSERS } from './vllm-tool-calling'
import { toolCallParserFor as backendParserFor, VLLM_TOOL_CALL_PARSERS as BACKEND_PARSERS } from '../../../../../backend/src/infrastructure/lib/vllm-tool-calling'

describe('the tool call parser for a model', () => {
  it.each([
    ['Qwen/Qwen2.5-0.5B-Instruct', 'hermes'],
    ['Qwen/Qwen3-8B', 'hermes'],
    ['Qwen/Qwen3-Coder-30B-A3B-Instruct', 'qwen3_xml'],
    ['Qwen/Qwen3.5-9B', 'qwen3_coder'],
    ['Qwen/Qwen3.6-35B-A3B', 'qwen3_coder'],
    ['meta-llama/Llama-3.2-3B-Instruct', 'llama3_json'],
    ['mistralai/Mistral-7B-Instruct-v0.3', 'mistral'],
    ['ibm-granite/granite-4.0-h-small', 'granite4'],
    ['openai/gpt-oss-20b', 'openai'],
    ['zai-org/GLM-4.7-Flash', 'glm47'],
  ])('is chosen for %s as %s', (model, parser) => {
    expect(toolCallParserFor(model)).toBe(parser)
  })

  it.each(['meta-llama/Llama-4-Scout-17B-16E-Instruct', 'someone/their-own-model', ''])('is not guessed for %s', (model) => {
    expect(toolCallParserFor(model)).toBeUndefined()
  })

  it('is one of the parsers vLLM has', () => {
    expect(VLLM_TOOL_CALL_PARSERS.map((entry) => entry.parser)).toContain(toolCallParserFor('Qwen/Qwen3-8B'))
  })
})

describe('the copy of the backend\'s rule', () => {
  it('offers the parsers the backend takes, and chooses the same one for every model', () => {
    expect([...VLLM_TOOL_CALL_PARSERS.map((entry) => entry.parser)].sort()).toEqual([...BACKEND_PARSERS].sort())
    for (const model of ['Qwen/Qwen2.5-0.5B-Instruct', 'Qwen/Qwen3-8B', 'Qwen/Qwen3-Coder-30B-A3B-Instruct', 'Qwen/Qwen3.6-27B', 'NousResearch/Hermes-3-Llama-3.1-8B', 'meta-llama/Meta-Llama-3.1-70B-Instruct', 'meta-llama/Llama-4-Scout-17B-16E-Instruct', 'mistralai/Devstral-Small-2505', 'ibm-granite/granite-3.1-8b-instruct', 'ibm-granite/granite-3.0-8b-instruct', 'ai21labs/AI21-Jamba-1.5-Mini', 'moonshotai/Kimi-K2-Instruct', 'tencent/Hunyuan-A13B-Instruct', 'zai-org/GLM-4.5-Air', 'allenai/Olmo-3-7B-Instruct', 'stepfun-ai/Step-3.5-Flash', 'meituan-longcat/LongCat-Flash-Chat', 'XiaomiMiMo/MiMo-V2.6-Flash-RL', 'ai-sage/GigaChat3-10B-A1.8B', 'someone/their-own-model']) {
      expect(toolCallParserFor(model)).toBe(backendParserFor(model))
    }
  })
})

describe('what the person chose about tool calling', () => {
  it('sends the parser chosen from the model, or the one picked', () => {
    expect(toolCallingOf('Qwen/Qwen3-8B', true, '')).toEqual({ enabled: true, parser: 'hermes', fromModel: 'hermes' })
    expect(toolCallingOf('Qwen/Qwen3-8B', true, 'pythonic')).toEqual({ enabled: true, parser: 'pythonic', fromModel: 'hermes' })
  })

  it('says to pick one when the model gives none', () => {
    expect(toolCallingOf('someone/their-own-model', true, '')).toEqual({
      enabled: true,
      problem: 'Koala cannot tell which tool call parser someone/their-own-model needs: pick one, or turn tool calling off.',
    })
  })

  it('sends no parser when tool calling is off', () => {
    expect(toolCallingOf('Qwen/Qwen3-8B', false, 'hermes')).toEqual({ enabled: false })
  })
})
