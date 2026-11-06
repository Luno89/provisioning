import { describe, expect, it } from 'vitest'
import type { ActionProposal } from '@koala/harness-types'
import { applyAction, getActionProgress, listConversationActions, listTreeActions, rejectAction } from './actions'
import { getMcpCatalogue } from './mcp'
import { startBackend } from '../../../test/backend/site'
import { mountEngine } from '../../../test/backend/engine'
import { anyOf, arrayWith, objectWith } from '../../../../../backend/src/platform/lib/test-matchers'

let engine: ReturnType<typeof mountEngine> | undefined
const backend = await startBackend((site) => { engine = mountEngine(site) })
const owner = await backend.signIn()
const now = new Date().toISOString()

const proposal = (id: string, over: Partial<ActionProposal> = {}): ActionProposal => ({
  id,
  ownerId: owner.id,
  kind: 'add_mcp_server',
  summary: 'Add the GPU tools server',
  detail: [],
  params: { spec: JSON.stringify({ name: 'gpu-tools', runs: { where: 'hosted', url: 'https://mcp.koala.test/mcp' }, agents: [], why: 'to read the GPU load' }) },
  status: 'proposed',
  conversationId: 'chat-1',
  createdAt: now,
  updatedAt: now,
  ...over,
})

await backend.db.engine.saveActionProposal(proposal('card-1'))
await backend.db.engine.saveActionProposal(proposal('card-2', { conversationId: undefined, treeId: 'tree-1' }))
await backend.db.engine.saveActionProposal(proposal('card-other', { ownerId: 'someone-else' }))

describe('cards Koala proposes, as the chat and the tree show them', () => {
  it('lists a chat\'s cards and a tree\'s cards, each only the person\'s', async () => {
    expect((await listConversationActions('chat-1')).map((card) => card.id)).toEqual(['card-1'])
    expect((await listTreeActions('tree-1')).map((card) => card.id)).toEqual(['card-2'])
  })

  it('has no progress to follow for a card that started nothing', async () => {
    await expect(getActionProgress('card-1')).rejects.toMatchObject({ response: { status: 404, data: { error: 'nothing that card started is being followed' } } })
  })

  it('applies a card adding an MCP server: the server is added, its capture starts, and the card says so', async () => {
    const applied = await applyAction('card-1')
    expect(applied).toEqual(objectWith({ id: 'card-1', status: 'applied', result: 'added gpu-tools; its tools are being captured', started: objectWith({ server: objectWith({ name: 'gpu-tools', added: true }) }) }))
    expect((await getMcpCatalogue()).servers).toEqual([objectWith({ name: 'gpu-tools', status: objectWith({ state: 'capturing' }) })])
    expect(engine!.started.at(-1)).toEqual(objectWith({ workflowType: 'AgentRunWorkflow', owner: owner.id }))
    expect(await getActionProgress('card-1')).toEqual(objectWith({ done: false, server: objectWith({ name: 'gpu-tools' }), steps: arrayWith([objectWith({ label: anyOf(String), state: anyOf(String) })]) }))
  })

  it('refuses to decide a card twice, and answers 404 for someone else\'s', async () => {
    await expect(applyAction('card-1')).rejects.toMatchObject({ response: { status: 409, data: { error: 'This proposal is already applied.' } } })
    await expect(rejectAction('card-other')).rejects.toMatchObject({ response: { status: 404, data: { error: 'Proposal not found' } } })
  })

  it('rejects a card', async () => {
    expect(await rejectAction('card-2')).toEqual(objectWith({ id: 'card-2', status: 'rejected' }))
  })
})
