import { describe, it, expect } from 'vitest'
import { ANY_MODEL, EVERY_MODEL, matchesModel, modelChoices, modelLine } from './memory-models'

describe('memories by model', () => {
  it('offers the models in use: those memories are kept for, the person\'s deployments and their default, once each', () => {
    const providers = [
      { id: 'tabby', source: 'deployment', model: 'qwen/q' },
      { id: 'blank', source: 'deployment', model: '' },
      { id: 'or-1', source: 'endpoint', model: 'a/b' },
      { id: 'or-2', source: 'endpoint', model: 'never/used' },
    ]
    expect(modelChoices([{ model: 'old/m' }, {}, { model: 'qwen/q' }], providers, 'or-1')).toEqual(['a/b', 'old/m', 'qwen/q'])
    expect(modelChoices([], providers)).toEqual(['qwen/q'])
  })

  it('shows what a model would recall: its own memories and those for every model', () => {
    const memories = [{ model: 'qwen/q' }, { model: 'old/m' }, {}]
    expect(memories.filter((memory) => matchesModel(memory, ANY_MODEL))).toHaveLength(3)
    expect(memories.filter((memory) => matchesModel(memory, EVERY_MODEL))).toEqual([{}])
    expect(memories.filter((memory) => matchesModel(memory, 'qwen/q'))).toEqual([{ model: 'qwen/q' }, {}])
  })

  it('says which model a memory is for', () => {
    expect(modelLine('qwen/q')).toBe('only for qwen/q')
    expect(modelLine(undefined)).toBe('every model')
  })
})
