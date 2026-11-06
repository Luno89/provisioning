import { describe, expect, it } from 'vitest'
import { listAutoModeAgents, setAgentAutoMode, setConversationAutoMode, setTreeAutoMode } from './auto-mode'
import { startBackend } from '../../../test/backend/site'
import { mountEngine } from '../../../test/backend/engine'

const backend = await startBackend((site) => { mountEngine(site) })
const owner = await backend.signIn()
const now = new Date().toISOString()
await backend.db.engine.saveConversation({ id: 'chat-1', ownerId: owner.id, title: 'A chat', messages: [], createdAt: now, updatedAt: now })
await backend.db.projects.saveTree({ id: 'tree-1', ownerId: owner.id, name: 'A tree', type: 'api', createdAt: now, updatedAt: now })

describe('auto mode, as the browser switches it', () => {
  it('starts with no agent on auto mode', async () => {
    expect(await listAutoModeAgents()).toEqual([])
  })

  it('switches an agent on and off, answering with the agents on', async () => {
    expect(await setAgentAutoMode('koala', true)).toEqual(['koala'])
    expect(await listAutoModeAgents()).toEqual(['koala'])
    expect(await setAgentAutoMode('koala', false)).toEqual([])
  })

  it('refuses to switch on an agent that does not exist', async () => {
    await expect(setAgentAutoMode('nobody-at-all', true)).rejects.toMatchObject({ response: { status: 404, data: { error: 'Agent not found' } } })
  })

  it('switches a chat on and off, and refuses a chat that does not exist', async () => {
    expect(await setConversationAutoMode('chat-1', true)).toBe(true)
    expect((await backend.db.engine.getConversation(owner.id, 'chat-1'))?.autoMode).toBe(true)
    expect(await setConversationAutoMode('chat-1', false)).toBe(false)
    await expect(setConversationAutoMode('no-chat', true)).rejects.toMatchObject({ response: { status: 404, data: { error: 'Conversation not found' } } })
  })

  it('switches a tree on, and refuses a tree that is not the person\'s', async () => {
    expect(await setTreeAutoMode('tree-1', true)).toBe(true)
    expect((await backend.db.projects.getTrees()).find((tree) => tree.id === 'tree-1')?.autoMode).toBe(true)
    await expect(setTreeAutoMode('no-tree', true)).rejects.toMatchObject({ response: { status: 404, data: { error: 'Tree not found' } } })
  })
})
