import { describe, expect, expectTypeOf, it } from 'vitest'
import { readDocument } from './documents'
import type { OpenedDocument } from '../types/documents'
import { startBackend } from '../../../test/backend/site'
import { mountEngine } from '../../../test/backend/engine'
import type { Wire } from '../../../test/backend/wire'
import type { OpenedDocument as BackendDocument } from '../../../../../backend/src/engine/services/DocumentService'

const backend = await startBackend((site) => { mountEngine(site) })
const owner = await backend.signIn()
const now = new Date().toISOString()
await backend.db.engine.saveConversation({ id: 'chat-1', ownerId: owner.id, title: 'Research', messages: [], createdAt: now, updatedAt: now })
await backend.db.engine.saveConversation({ id: 'chat-other', ownerId: 'someone-else', title: 'Theirs', messages: [], createdAt: now, updatedAt: now })

expectTypeOf<Wire<BackendDocument>>().toExtend<OpenedDocument>()

describe('opening a document a chat saved, as the browser asks for it', () => {
  it('answers 404 for a workspace that is someone else\'s or no workspace at all', async () => {
    await expect(readDocument({ workspace: 'conversation-chat-other', path: 'findings.md' })).rejects.toMatchObject({ response: { status: 404, data: { error: 'there is no saved workspace called conversation-chat-other' } } })
    await expect(readDocument({ workspace: 'nothing', path: 'findings.md' })).rejects.toMatchObject({ response: { status: 404 } })
  })

  it('refuses a path outside the workspace and a version that is not a commit', async () => {
    await expect(readDocument({ workspace: 'conversation-chat-1', path: '../secrets' })).rejects.toMatchObject({ response: { status: 400, data: { error: '../secrets is not a path inside the workspace' } } })
    await expect(readDocument({ workspace: 'conversation-chat-1', path: 'findings.md', at: 'yesterday' })).rejects.toMatchObject({ response: { status: 400, data: { error: 'yesterday is not a commit' } } })
  })
})
