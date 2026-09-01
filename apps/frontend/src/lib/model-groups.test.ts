import { describe, it, expect } from 'vitest'
import {
  groupModels, tierModels, vendorOf, sourceOf, modelRowLabel, isLocal, isFree, formatPrice,
  formatContext, formatIntelligence,
} from './model-groups'
import type { ModelProvider } from '../api/models'

const priced = (promptPerMTok: number, completionPerMTok: number) => ({
  pricing: { promptPerMTok, completionPerMTok },
})

const gateway = (model: string, over: Partial<ModelProvider> = {}): ModelProvider =>
  ({ id: model, name: `OpenRouter · ${model}`, source: 'endpoint', sourceLabel: 'OpenRouter', model, ...over }) as ModelProvider

const deployment = (model: string, kind: 'vllm' | 'tabbyapi' = 'tabbyapi'): ModelProvider =>
  ({ id: model, name: 'Tabbyapi-Production', source: 'deployment', kind, model }) as ModelProvider

describe('isLocal', () => {
  it('counts a deployment and a mesh machine, not a public gateway', () => {
    expect(isLocal(deployment('m'))).toBe(true)
    expect(isLocal(gateway('a/b', { isMesh: true }))).toBe(true)
    expect(isLocal(gateway('a/b'))).toBe(false)
  })
})

describe('isFree', () => {
  it('reads the price, not the name — a zero-priced model need not say ":free"', () => {
    expect(isFree(gateway('vendor/quiet-freebie', priced(0, 0)))).toBe(true)
  })

  it('does not trust a ":free" name over a non-zero price', () => {
    expect(isFree(gateway('vendor/model:free', priced(0.5, 1)))).toBe(false)
  })

  it('treats an unquoted price as unknown, not as free', () => {
    expect(isFree(gateway('vendor/model'))).toBe(false)
  })
})

describe('formatPrice', () => {
  it('quotes dollars per million tokens, in over out', () => {
    expect(formatPrice(gateway('a/b', priced(10, 50)))).toBe('$10/$50')
  })

  it('keeps cents on sub-dollar prices, which most models are', () => {
    expect(formatPrice(gateway('a/b', priced(0.15, 0.6)))).toBe('$0.15/$0.60')
  })

  it('says free rather than $0/$0', () => {
    expect(formatPrice(gateway('a/b', priced(0, 0)))).toBe('free')
  })

  it('says nothing when the gateway quoted no price', () => {
    expect(formatPrice(gateway('a/b'))).toBeUndefined()
  })
})

describe('sourceOf and vendorOf', () => {
  it('uses the label the backend wrote, falling back for older rows', () => {
    expect(sourceOf(gateway('a/b'))).toBe('OpenRouter')
    expect(sourceOf(deployment('m', 'tabbyapi'))).toBe('TabbyAPI')
    expect(sourceOf(deployment('m', 'vllm'))).toBe('vLLM')
  })

  it('takes the vendor from the id, but never for a deployment', () => {
    expect(vendorOf(gateway('anthropic/claude'))).toBe('anthropic')
    expect(vendorOf(gateway('gpt-4'))).toBeUndefined()
    expect(vendorOf(deployment('turboderp/Qwen3-27B'))).toBeUndefined()
  })
})

describe('groupModels', () => {
  it('nests vendors under their source', () => {
    const [group] = groupModels([
      gateway('anthropic/opus', priced(10, 50)),
      gateway('anthropic/sonnet', priced(3, 15)),
      gateway('google/gemini', priced(1, 2)),
    ])
    expect(group!.label).toBe('OpenRouter')
    expect(group!.models).toHaveLength(3)
    expect(group!.vendors.map((v) => [v.label, v.models.length])).toEqual([
      ['anthropic', 2], ['google', 1],
    ])
  })

  it('collects the free models ahead of the vendors, out of every vendor', () => {
    const [group] = groupModels([
      gateway('anthropic/opus', priced(10, 50)),
      gateway('anthropic/tiny', priced(0, 0)),
      gateway('google/tiny', priced(0, 0)),
    ])
    expect(group!.vendors[0]).toMatchObject({ label: 'Free', free: true })
    expect(group!.vendors[0]!.models).toHaveLength(2)
    // and they are not also left under their vendor
    expect(group!.vendors.find((v) => v.label === 'anthropic')!.models).toHaveLength(1)
    expect(group!.vendors.find((v) => v.label === 'google')).toBeUndefined()
  })

  it('sorts a local source above a gateway, whatever they are called', () => {
    const groups = groupModels([gateway('aaa/model'), deployment('zzz-model')])
    expect(groups.map((g) => g.label)).toEqual(['TabbyAPI', 'OpenRouter'])
  })

  it('sorts a gateway it has never heard of by the same rules', () => {
    const groups = groupModels([
      gateway('a/m', { sourceLabel: 'Zebra Cloud' }),
      gateway('a/m2', { sourceLabel: 'Acme AI' }),
    ])
    expect(groups.map((g) => g.label)).toEqual(['Acme AI', 'Zebra Cloud'])
  })

  it('lifts the group the account already points at above the rest', () => {
    const groups = groupModels(
      [gateway('a/m', { sourceLabel: 'Zebra Cloud', id: 'z1' }), gateway('b/m', { sourceLabel: 'Acme AI' })],
      { defaultModelId: 'z1' },
    )
    expect(groups.map((g) => g.label)).toEqual(['Zebra Cloud', 'Acme AI'])
  })

  it('keeps a model with no vendor prefix beside its source', () => {
    const [group] = groupModels([gateway('gpt-4')])
    expect(group!.vendors).toEqual([])
    expect(group!.ungrouped.map((m) => m.model)).toEqual(['gpt-4'])
  })
})

describe('tierModels', () => {
  it('separates what you control from what you have set up', () => {
    const { local, provisioned } = tierModels([deployment('qwen'), gateway('a/b')])
    expect(local.map((g) => g.label)).toEqual(['TabbyAPI'])
    expect(provisioned.map((g) => g.label)).toEqual(['OpenRouter'])
  })

  it('has no tiers for an account with no models', () => {
    expect(tierModels([])).toEqual({ local: [], provisioned: [] })
  })
})

describe('modelRowLabel', () => {
  it('drops the vendor only when the row sits under it', () => {
    expect(modelRowLabel(gateway('anthropic/opus'), true)).toBe('opus')
    expect(modelRowLabel(gateway('anthropic/opus'), false)).toBe('anthropic/opus')
  })

  it('falls back to the row name when there is no model id', () => {
    expect(modelRowLabel({ ...gateway(''), name: 'Workstation' } as ModelProvider, false)).toBe('Workstation')
  })
})

describe('formatContext', () => {
  it('reads windows under a million in thousands', () => {
    expect(formatContext(128_000)).toBe('128k')
    expect(formatContext(32_000)).toBe('32k')
  })

  it('reads a million or more in millions, since the 200k clamp is gone', () => {
    expect(formatContext(1_000_000)).toBe('1M')
    expect(formatContext(2_000_000)).toBe('2M')
    expect(formatContext(1_500_000)).toBe('1.5M')
  })

  it('says nothing when the window is unknown', () => {
    expect(formatContext(undefined)).toBeUndefined()
    expect(formatContext(0)).toBeUndefined()
  })
})

describe('formatIntelligence', () => {
  it('shows a whole score plainly and a fractional one to one place', () => {
    expect(formatIntelligence(gateway('a/b', { intelligence: 71 } as never))).toBe('71')
    expect(formatIntelligence(gateway('a/b', { intelligence: 60.14 } as never))).toBe('60.1')
  })

  it('shows nothing when their catalogue had no match, rather than a zero', () => {
    expect(formatIntelligence(gateway('a/b'))).toBeUndefined()
  })

  it('shows a genuine zero, which is a score', () => {
    expect(formatIntelligence(gateway('a/b', { intelligence: 0 } as never))).toBe('0')
  })
})
