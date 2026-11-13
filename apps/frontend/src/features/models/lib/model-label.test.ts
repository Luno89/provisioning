import { describe, it, expect } from 'vitest'
import { modelOptionLabel } from './model-label'
import type { ModelProvider } from '../api'

const provider = (over: Partial<ModelProvider>): ModelProvider =>
  ({ id: 'x', name: 'Name', source: 'endpoint', model: '', ...over }) as ModelProvider

describe('modelOptionLabel', () => {
  it('prefers the label the backend supplies', () => {
    expect(modelOptionLabel(provider({ sourceLabel: 'OpenRouter', model: 'anthropic/claude-opus-4' })))
      .toBe('[OpenRouter] anthropic/claude-opus-4')
  })

  it('names the engine for a deployment row that predates sourceLabel, and the deployment it runs on', () => {
    expect(modelOptionLabel(provider({ source: 'deployment', kind: 'tabbyapi', model: 'Qwen3-32B', name: 'big' })))
      .toBe('[TabbyAPI] Qwen3-32B · big')
    expect(modelOptionLabel(provider({ source: 'deployment', kind: 'vllm', model: 'Qwen3-32B', name: 'small' })))
      .toBe('[vLLM] Qwen3-32B · small')
  })

  it('tells two deployments of one model apart by their names', () => {
    const one = modelOptionLabel(provider({ source: 'deployment', sourceLabel: 'vLLM', kind: 'vllm', model: 'Qwen/Qwen2.5-0.5B-Instruct', name: 'qwen-a' }))
    const two = modelOptionLabel(provider({ source: 'deployment', sourceLabel: 'vLLM', kind: 'vllm', model: 'Qwen/Qwen2.5-0.5B-Instruct', name: 'qwen-b' }))
    expect([one, two]).toEqual(['[vLLM] Qwen/Qwen2.5-0.5B-Instruct · qwen-a', '[vLLM] Qwen/Qwen2.5-0.5B-Instruct · qwen-b'])
  })

  it('calls a bare endpoint Custom', () => {
    expect(modelOptionLabel(provider({ source: 'endpoint', model: 'llama' }))).toBe('[Custom] llama')
  })

  it('falls back to the row name when it carries no model', () => {
    expect(modelOptionLabel(provider({ sourceLabel: 'OpenRouter', name: 'Workstation', model: '' })))
      .toBe('[OpenRouter] Workstation')
  })
})
