import { describe, expect, expectTypeOf, it } from 'vitest'
import { type StartedRun, answerRun, cancelRun, listEngineAgents, listRunEndings, listRunTraces, startRun } from './engine'
import { type ChatConversation, createChatConversation, deleteChatConversation, getChatConversation, getConversationContext, listChatConversations, patchChatConversation } from './chat-pack'
import { startBackend } from '../../../test/backend/site'
import { machinesOf, type Machines } from '../../../test/backend/machines'
import { engineRouter } from '../../../../../backend/src/engine/routes/engine'
import { conversationsRouter } from '../../../../../backend/src/engine/routes/conversations'
import { ApprovalService } from '../../../../../backend/src/engine/services/ApprovalService'
import { ConversationTurnService } from '../../../../../backend/src/engine/services/ConversationTurnService'
import { extensionServiceFor } from '../../../../../backend/src/engine/services/ExtensionService'
import { createRunStarter, type StartedRun as BackendStartedRun, type WorkflowStarter } from '../../../../../backend/src/engine-host/registries/run-starter'
import { createStoredAgentRegistry } from '../../../../../backend/src/engine-host/registries/registry'
import { directoryFromDatabase } from '../../../../../backend/src/engine-host/registries/agent-directory'
import { conversationBinding } from '../../../../../backend/src/engine-host/conversation-binding'
import { accountDefaultOf } from '../../../../../backend/src/machines/lib/machine-runs'
import type { Conversation } from '../../../../../backend/src/engine/lib/conversations'
import type { Wire } from '../../../test/backend/wire'
import { RUN_AGENT_MEMO, RUN_CONVERSATION_MEMO, RUN_ID_MEMO, workflowOfRun } from '../../../../../backend/src/engine-host/temporal/contracts'
import { anyOf, containing, objectWith } from '../../../../../backend/src/platform/lib/test-matchers'
import { runsActingAsTheirOwner } from '../../../../../backend/src/engine/testing/run-grants'

interface Started { workflowType: string; workflowId: string; taskQueue: string; args: unknown[]; owner: string; memo: Record<string, unknown> }

const started: Started[] = []
const engine: { reachable: boolean } = { reachable: true }
let side: Machines | undefined

const backend = await startBackend(({ api, db, ...site }) => {
  side = machinesOf({ api, db, ...site })
  const machines = side.machines
  const extensions = extensionServiceFor(db)
  const registry = createStoredAgentRegistry({
    agents: directoryFromDatabase(db.engine, { hidden: (ownerId) => extensions.hidden(ownerId) }),
    procedures: { list: (ownerId) => db.engine.getProcedures(ownerId) },
    hidden: (ownerId) => extensions.hidden(ownerId),
    published: (ownerId) => extensions.groups(ownerId),
    accountDefault: async (ownerId) => accountDefaultOf(await db.accounts.getUserById(ownerId)),
  })
  const turns = new ConversationTurnService({ store: db.engine, log: db.engine, running: async () => true })
  const workflows: WorkflowStarter = {
    start: async (workflowType, options) => {
      started.push({ workflowType, ...options })
      return { workflowId: options.workflowId }
    },
    signal: async () => undefined,
  }
  const runs = createRunStarter({
    ...runsActingAsTheirOwner(),
    registry,
    turns,
    workflows: () => (engine.reachable ? workflows : undefined),
    binding: conversationBinding(db),
    machines: (ownerId, choice) => machines.choiceProblem(ownerId, choice),
  })
  api.use('/engine', engineRouter({
    runs,
    registry,
    approvals: new ApprovalService({ store: db.engine, runs }),
    traces: { list: (ownerId, runId) => db.engine.getRunTraces(ownerId, runId) },
    endings: { list: async () => [] },
    extensions,
  }))
  api.use('/conversations', conversationsRouter({
    db,
    ownedConversations: async (userId) => (await db.engine.getConversations()).filter((conversation) => conversation.ownerId === userId),
    ownedTrees: async (userId) => (await db.projects.getTrees()).filter((tree) => tree.ownerId === userId),
    ownedProjects: async (userId) => (await db.projects.getProjects()).filter((project) => project.ownerId === userId),
    workspaces: { conclude: async () => undefined },
    turns,
    binding: conversationBinding(db),
  }))
})

const owner = await backend.signIn()

expectTypeOf<Wire<Conversation>>().toExtend<ChatConversation>()
expectTypeOf<Wire<BackendStartedRun>>().toExtend<StartedRun>()

describe('a chat, as the chat surface asks for it', () => {
  it('lists the agents a chat can run, Koala among them, in the shape the picker reads', async () => {
    const agents = await listEngineAgents()
    const koala = agents.find((agent) => agent.slug === 'koala')
    expect(koala).toMatchObject({ slug: 'koala', name: anyOf(String), loop: anyOf(String), mine: false })
    expect(Array.isArray(koala?.tools)).toBe(true)
    expect(Array.isArray(koala?.canDelegateTo)).toBe(true)
  })

  it('makes a conversation, lists it with its message count, and reads it back', async () => {
    const made = await createChatConversation('About my GPU')
    expect(made).toMatchObject({ id: anyOf(String), title: 'About my GPU', messages: [] })
    expect(await listChatConversations()).toEqual([objectWith({ id: made.id, title: 'About my GPU', messageCount: 0 })])
    expect(await getChatConversation(made.id)).toMatchObject({ id: made.id, title: 'About my GPU' })
  })

  it('pins a model and an agent on the conversation and keeps them', async () => {
    const [conversation] = await listChatConversations()
    const patched = await patchChatConversation(conversation!.id, { modelId: 'tabby-qwen', agentSlug: 'koala', modelReach: 'chat' })
    expect(patched).toMatchObject({ id: conversation!.id, modelId: 'tabby-qwen', agentSlug: 'koala', modelReach: 'chat' })
  })

  it('reads what Koala is handed in an unbound conversation', async () => {
    const [conversation] = await listChatConversations()
    const context = await getConversationContext(conversation!.id)
    expect(context).toEqual({ given: anyOf(Object), text: anyOf(String) })
  })

  it('starts a turn the way the composer sends it, and the run starts on the engine for that conversation', async () => {
    const [conversation] = await listChatConversations()
    const run = await startRun({ agent: 'koala', message: 'Is my GPU busy?', conversationId: conversation!.id, modelId: 'tabby-qwen', modelReach: 'chat' })
    expect(run).toEqual({ runId: anyOf(String), agentSlug: 'koala', loopId: anyOf(String) })
    expect(started.at(-1)).toMatchObject({
      workflowType: 'AgentRunWorkflow',
      workflowId: workflowOfRun(run.runId),
      owner: owner.id,
      memo: { [RUN_ID_MEMO]: run.runId, [RUN_AGENT_MEMO]: 'koala', [RUN_CONVERSATION_MEMO]: conversation!.id },
      args: [objectWith({ inputs: objectWith({ conversationId: conversation!.id, message: 'Is my GPU busy?' }) })],
    })
    const read = await getChatConversation(conversation!.id)
    expect(read?.liveTurn).toMatchObject({ runId: run.runId })
    expect(read?.messages?.at(-1)).toMatchObject({ role: 'user', content: 'Is my GPU busy?', runId: run.runId })
  })

  it('reads a fresh run\'s traces and endings as empty lists', async () => {
    expect(await listRunTraces('run-none')).toEqual([])
    expect(await listRunEndings(['run-none'])).toEqual([])
  })

  it('refuses a turn with no agent or no message, saying which', async () => {
    await expect(startRun({ agent: '', message: 'hi' })).rejects.toMatchObject({ response: { status: 400, data: { error: 'agent is required' } } })
    await expect(startRun({ agent: 'koala', message: ' ' })).rejects.toMatchObject({ response: { status: 400, data: { error: 'message is required' } } })
  })

  it('answers 404 for an agent that does not exist', async () => {
    await expect(startRun({ agent: 'nobody-at-all', message: 'hi' })).rejects.toMatchObject({ response: { status: 404, data: { error: containing('nobody-at-all') } } })
  })

  it('refuses a turn on a machine that is not connected with MACHINE_UNAVAILABLE and the reason', async () => {
    const deviceId = await side!.join('desk', (await side!.accounts.createJoinCode(owner.id)).code)
    await side!.agents(deviceId, [{ id: 'claude-code', title: 'Claude Code', state: 'ready', source: 'found' }])
    const conversation = await createChatConversation('On my machine')
    await expect(startRun({ agent: 'koala', message: 'hi', conversationId: conversation.id, modelId: `machine:${deviceId}:claude-code` }))
      .rejects.toMatchObject({ response: { status: 409, data: { error: 'This run cannot go to that machine: desk is not connected, so Claude Code cannot answer.', code: 'MACHINE_UNAVAILABLE' } } })
  })

  it('answers 503 while the engine cannot be reached, with the reason', async () => {
    engine.reachable = false
    await expect(startRun({ agent: 'koala', message: 'hi' })).rejects.toMatchObject({ response: { status: 503, data: { error: anyOf(String) } } })
    engine.reachable = true
  })

  it('refuses to answer, approve or cancel a run that is not the person\'s', async () => {
    await expect(answerRun('run-of-nobody', 'ask', 'yes')).rejects.toMatchObject({ response: { status: 404, data: { error: 'You have no run with that id' } } })
    await expect(cancelRun('run-of-nobody')).rejects.toMatchObject({ response: { status: 404 } })
  })

  it('refuses every turn once the account is being removed, since its session ends at once', async () => {
    const record = await backend.db.accounts.getUserById(owner.id)
    await backend.db.accounts.saveUser({ ...record!, removal: { startedAt: new Date().toISOString(), requestedBy: owner.id } })
    await expect(startRun({ agent: 'koala', message: 'hi' })).rejects.toMatchObject({ response: { status: 401 } })
    await backend.db.accounts.saveUser(record!)
  })

  it('deletes a conversation, after which it is gone', async () => {
    const conversation = await createChatConversation('Throwaway')
    await deleteChatConversation(conversation.id)
    await expect(getChatConversation(conversation.id)).rejects.toMatchObject({ response: { status: 404 } })
  })

  it('shows another person none of the first person\'s conversations', async () => {
    await backend.signInAnother('second@koala.test')
    expect(await listChatConversations()).toEqual([])
  })
})
