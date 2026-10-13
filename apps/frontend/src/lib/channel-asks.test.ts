import { describe, expect, it } from 'vitest'
import { addressOf, channelAsksKoala, goesToKoala, rememberChannelAsks } from './channel-asks'

const memoryStore = () => {
  const rows = new Map<string, string>()
  return { getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => void rows.set(key, value) }
}

describe('channel asks', () => {
  it('is off until turned on, and is kept per channel', () => {
    const store = memoryStore()
    expect(channelAsksKoala('channel-a', store)).toBe(false)
    rememberChannelAsks('channel-a', true, store)
    expect(channelAsksKoala('channel-a', store)).toBe(true)
    expect(channelAsksKoala('channel-b', store)).toBe(false)
    rememberChannelAsks('channel-a', false, store)
    expect(channelAsksKoala('channel-a', store)).toBe(false)
  })

  it('reads as off when storage throws', () => {
    const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
    expect(channelAsksKoala('channel-a', broken)).toBe(false)
    expect(() => rememberChannelAsks('channel-a', true, broken)).not.toThrow()
  })

  it('sends to Koala when asking is on or the message names @koala', () => {
    expect(goesToKoala('a note', false)).toBe(false)
    expect(goesToKoala('@koala what is live?', false)).toBe(true)
    expect(goesToKoala('a question', true)).toBe(true)
  })

  it('says who a person message went to', () => {
    expect(addressOf({ role: 'user' }, false)).toBe('channel')
    expect(addressOf({ role: 'user', runId: 'run-1' }, false)).toBe('koala')
    expect(addressOf({ role: 'user' }, true)).toBe('koala')
    expect(addressOf({ role: 'assistant', runId: 'run-1' }, false)).toBeUndefined()
    expect(addressOf({ role: 'notice' }, false)).toBeUndefined()
  })
})
