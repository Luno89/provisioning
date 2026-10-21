import { describe, it, expect } from 'vitest'
import type { ModelProvider } from '../api/models'
import { firstModelChoices, firstModelStep } from './first-model'

const model = (id: string, extra: Partial<ModelProvider> = {}): ModelProvider =>
  ({ id, name: id, source: 'endpoint', model: id, ...extra }) as ModelProvider

describe('the first model a person picks', () => {
  it('asks to connect when there is no model, to choose when there are some and none is the default, and nothing once one is', () => {
    expect(firstModelStep([], null)).toBe('connect')
    expect(firstModelStep([model('a')], null)).toBe('choose')
    expect(firstModelStep([model('a')], 'gone')).toBe('none')
    expect(firstModelStep([], 'tabby-down-for-now')).toBe('none')
    expect(firstModelStep([model('a')], 'a')).toBe('none')
  })

  it('offers their own models first, then free ones strongest first, and keeps paid ones apart, unpriced counted as paid', () => {
    const free = { promptPerMTok: 0, completionPerMTok: 0 }
    const choices = firstModelChoices([
      model('paid/big', { pricing: { promptPerMTok: 3, completionPerMTok: 15 }, intelligence: 70 }),
      model('free/weak', { pricing: free, intelligence: 20 }),
      model('free/strong', { pricing: free, intelligence: 50 }),
      model('unpriced/x'),
      model('tabby', { source: 'deployment', kind: 'tabbyapi' }),
    ])
    expect(choices.yours.map((m) => m.id)).toEqual(['tabby'])
    expect(choices.free.map((m) => m.id)).toEqual(['free/strong', 'free/weak'])
    expect(choices.paid.map((m) => m.id)).toEqual(['paid/big', 'unpriced/x'])
  })
})

describe('an agent on the person\'s machine as the first model', () => {
  const row = (id: string, ready: boolean, label = id) => ({ id, agentTitle: 'Claude Code', deviceName: 'laptop', label, ready }) as never

  it('never asks someone who has a default, wherever it is, and offers a ready one to someone who has none', () => {
    expect(firstModelStep([], 'machine:d1:claude-code', [row('machine:d1:claude-code', false)])).toBe('none')
    expect(firstModelStep([], 'machine:gone:claude-code', [row('machine:d1:claude-code', true)])).toBe('none')
    expect(firstModelStep([], null, [row('machine:d1:claude-code', false)])).toBe('connect')
    expect(firstModelStep([], null, [row('machine:d1:claude-code', true)])).toBe('choose')
  })

  it('lists only the ready ones, by name', () => {
    expect(firstModelChoices([], [row('b', true, 'Codex · laptop'), row('a', true, 'Claude Code · laptop'), row('c', false)]).machines.map((entry: { id: string }) => entry.id)).toEqual(['a', 'b'])
  })
})
