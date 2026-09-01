import { describe, it, expect } from 'vitest'
import { modelOptionLabel } from './model-label'
import type { ModelProvider } from '../api/models'

const provider = (over: Partial<ModelProvider>): ModelProvider =>
  ({ id: 'x', name: 'Name', source: 'endpoint', model: '', ...over }) as ModelProvider

describe('modelOptionLabel', () => {
  it('prefers the label the backend supplies', () => {
    expect(modelOptionLabel(provider({ sourceLabel: 'OpenRouter', model: 'anthropic/claude-opus-4' })))
      .toBe('[OpenRouter] anthropic/claude-opus-4')
  })

  it('names the engine for a deployment row that predates sourceLabel', () => {
    expect(modelOptionLabel(provider({ source: 'deployment', kind: 'tabbyapi', model: 'Qwen3-32B' })))
      .toBe('[TabbyAPI] Qwen3-32B')
    expect(modelOptionLabel(provider({ source: 'deployment', kind: 'vllm', model: 'Qwen3-32B' })))
      .toBe('[vLLM] Qwen3-32B')
  })

  it('calls a bare endpoint Custom', () => {
    expect(modelOptionLabel(provider({ source: 'endpoint', model: 'llama' }))).toBe('[Custom] llama')
  })

  it('falls back to the row name when it carries no model', () => {
    expect(modelOptionLabel(provider({ sourceLabel: 'OpenRouter', name: 'Workstation', model: '' })))
      .toBe('[OpenRouter] Workstation')
  })
})
