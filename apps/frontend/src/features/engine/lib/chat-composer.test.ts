import { describe, it, expect } from 'vitest'
import { channelPlaceholder, composerModelLabel, packOption, sendKind, type SendSituation } from './chat-composer'

const situation = (over: Partial<SendSituation> = {}): SendSituation => ({
  text: 'hello',
  attachments: 0,
  streaming: false,
  uploading: false,
  channel: false,
  conversationId: 'c1',
  toKoala: false,
  ...over,
})

describe('sendKind', () => {
  it('sends nothing without text or attachments, while streaming or while uploading', () => {
    expect(sendKind(situation({ text: '' }))).toBe('none')
    expect(sendKind(situation({ streaming: true }))).toBe('none')
    expect(sendKind(situation({ uploading: true }))).toBe('none')
  })

  it('sends attachments alone', () => {
    expect(sendKind(situation({ text: '', attachments: 1 }))).toBe('turn')
  })

  it('starts a turn outside a channel', () => {
    expect(sendKind(situation())).toBe('turn')
  })

  it('posts in a channel unless the message goes to Koala', () => {
    expect(sendKind(situation({ channel: true }))).toBe('post')
    expect(sendKind(situation({ channel: true, toKoala: true }))).toBe('turn')
  })

  it('starts a turn in a channel with no conversation yet', () => {
    expect(sendKind(situation({ channel: true, conversationId: null }))).toBe('turn')
  })
})

describe('packOption', () => {
  it('names the agent in capitals and keeps its description', () => {
    expect(packOption({ slug: 'koala', name: 'Koala', description: 'helps' })).toEqual({ id: 'koala', name: 'Koala', label: 'KOALA', desc: 'helps' })
    expect(packOption({ slug: 'koala', name: 'Koala' })?.desc).toBe('')
    expect(packOption(undefined)).toBeUndefined()
  })
})

describe('composerModelLabel', () => {
  it('prefers the machine, then the model, then the pinned id', () => {
    expect(composerModelLabel('My laptop · Claude', 'Qwen', 'm1')).toBe('My laptop · Claude')
    expect(composerModelLabel(undefined, 'Qwen', 'm1')).toBe('Qwen')
    expect(composerModelLabel(undefined, undefined, 'm1')).toBe('m1')
    expect(composerModelLabel(undefined, undefined, null)).toBe('No model')
  })
})

describe('channelPlaceholder', () => {
  it('says where the message goes', () => {
    expect(channelPlaceholder(true)).toBe('Ask Koala — it answers in the channel')
    expect(channelPlaceholder(false)).toBe('Post to the channel — start with @koala to ask Koala')
  })
})
