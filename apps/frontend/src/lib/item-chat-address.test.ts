import { describe, it, expect } from 'vitest'
import { itemChatAddress } from './item-chat-address'

describe('where a chat about a story or a feature opens', () => {
  const leaves = [{ id: 'l1', branchId: 'b1' }]

  it('opens a story\'s chat on the story\'s page and a feature\'s on the feature\'s', () => {
    expect(itemChatAddress({ kind: 'item', treeId: 't1', leafId: 'l1' }, leaves)).toBe('#/projects/tree/t1/b1/l1')
    expect(itemChatAddress({ kind: 'item', treeId: 't1', branchId: 'b2' }, leaves)).toBe('#/projects/tree/t1/b2')
  })

  it('leaves any other chat, and a story no longer there, to the chat page', () => {
    expect(itemChatAddress({ treeId: 't1' }, leaves)).toBeUndefined()
    expect(itemChatAddress({ kind: 'channel', treeId: 't1' }, leaves)).toBeUndefined()
    expect(itemChatAddress({ kind: 'item', treeId: 't1', leafId: 'gone' }, leaves)).toBeUndefined()
  })
})
