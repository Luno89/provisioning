import { describe, expect, expectTypeOf, it } from 'vitest'
import { type McpCatalogue, type McpServer, addMcpServer, captureMcpServer, dismissMcpRequest, enableMcpRequest, getMcpCatalogue, listMcpRequests, listMcpServers, removeMcpServer, saveMcpServer, setConversationServers } from './mcp'
import { startBackend } from '../../../test/backend/site'
import { mountEngine } from '../../../test/backend/engine'
import type { Wire } from '../../../test/backend/wire'
import type { McpCatalogue as BackendCatalogue, McpServerView } from '../../../../../backend/src/engine/services/McpServerService'
import { runsFingerprint } from '../../../../../backend/src/engine/lib/mcp-servers'
import { anyOf, arrayWith, objectWith } from '../../../../../backend/src/platform/lib/test-matchers'

let engine: ReturnType<typeof mountEngine> | undefined
const backend = await startBackend((site) => { engine = mountEngine(site) })
const owner = await backend.signIn()
const now = new Date().toISOString()
await backend.db.engine.saveConversation({ id: 'chat-1', ownerId: owner.id, title: 'Tools', messages: [], createdAt: now, updatedAt: now })

const hosted = { where: 'hosted' as const, url: 'https://mcp.koala.test/mcp' }

describe('the shapes the browser reads are the shapes the backend sends', () => {
  it('reads a server and the catalogue as the backend describes them', () => {
    expectTypeOf<Wire<McpServerView>>().toExtend<McpServer>()
    expectTypeOf<Wire<BackendCatalogue>>().toExtend<McpCatalogue>()
  })
})

describe('the catalogue of MCP servers, as the Studio asks for it', () => {
  it('offers the known servers as templates, none added yet', async () => {
    expect(await getMcpCatalogue()).toEqual({ servers: [], templates: arrayWith([objectWith({ id: 'playwright', added: false, runs: objectWith({ where: 'workspace' }) })]) })
  })

  it('adds a known server from its template, which starts capturing it on the engine', async () => {
    const added = await addMcpServer({ template: 'playwright' })
    expect(added).toEqual(objectWith({ name: anyOf(String), from: { template: 'playwright' }, status: objectWith({ state: 'capturing', runId: anyOf(String) }) }))
    expect(engine!.started.at(-1)).toEqual(objectWith({ workflowType: 'AgentRunWorkflow', owner: owner.id }))
    expect((await getMcpCatalogue()).templates).toEqual(arrayWith([objectWith({ id: 'playwright', added: true })]))
  })

  it('adds a hosted server by its address, and refuses a second of the same name and an unknown template', async () => {
    expect(await addMcpServer({ name: 'gpu-tools', runs: hosted, summary: 'GPU tools' })).toEqual(objectWith({ name: 'gpu-tools', runs: hosted, summary: 'GPU tools' }))
    await expect(addMcpServer({ name: 'gpu-tools', runs: hosted })).rejects.toMatchObject({ response: { status: 409, data: { error: anyOf(String) } } })
    await expect(addMcpServer({ template: 'no-such-server' })).rejects.toMatchObject({ response: { status: 404, data: { error: 'there is no known server called "no-such-server"' } } })
  })

  it('saves notes on a server, and refuses to capture it while it is being captured', async () => {
    const server = (await getMcpCatalogue()).servers.find((entry) => entry.name === 'gpu-tools')!
    expect(await saveMcpServer(server.id, { notes: 'Ask before restarting anything' })).toEqual(objectWith({ id: server.id, notes: 'Ask before restarting anything' }))
    await expect(captureMcpServer(server.id)).rejects.toMatchObject({ response: { status: 409, data: { error: 'gpu-tools is being captured already' } } })
    await expect(captureMcpServer('no-such-server')).rejects.toMatchObject({ response: { status: 404, data: { error: 'Server not found' } } })
  })

  it('lists a captured hosted server with its tools for the chat', async () => {
    const server = (await backend.db.engine.getMcpServers(owner.id)).find((entry) => entry.name === 'gpu-tools')!
    const { capturing: _capturing, ...rest } = server
    await backend.db.engine.saveMcpServer({ ...rest, captured: { tools: [{ name: 'gpu_load', description: 'How busy the GPU is', annotations: { readOnlyHint: true } }], at: new Date().toISOString(), fingerprint: runsFingerprint(server.runs) } })
    expect(await listMcpServers()).toEqual(arrayWith([{ name: 'gpu-tools', tools: [objectWith({ name: 'gpu_load', description: 'How busy the GPU is', readOnly: anyOf(Boolean), kind: anyOf(String), declared: anyOf(String) })] }]))
    expect(await captureMcpServer(server.id)).toEqual(objectWith({ id: server.id, status: objectWith({ state: 'capturing' }) }))
    await backend.db.engine.saveMcpServer({ ...rest, captured: { tools: [{ name: 'gpu_load', description: 'How busy the GPU is', annotations: { readOnlyHint: true } }], at: new Date().toISOString(), fingerprint: runsFingerprint(server.runs) } })
  })

  it('switches servers on for a chat, refusing one the person does not have and a chat that does not exist', async () => {
    expect(await setConversationServers('chat-1', ['gpu-tools'])).toEqual({ conversation: objectWith({ id: 'chat-1', mcpServers: ['gpu-tools'] }) })
    await expect(setConversationServers('chat-1', ['nope'])).rejects.toMatchObject({ response: { status: 400, data: { error: 'not one of your MCP servers: nope' } } })
    await expect(setConversationServers('no-chat', [])).rejects.toMatchObject({ response: { status: 404, data: { error: 'No such conversation' } } })
  })

  it('reads a chat\'s requests for a server, enables one and refuses to decide it twice', async () => {
    await backend.db.engine.saveMcpRequest({ id: 'ask-1', ownerId: owner.id, conversationId: 'chat-1', server: 'gpu-tools', why: 'to read the GPU load', status: 'requested', createdAt: now, updatedAt: now })
    await backend.db.engine.saveMcpRequest({ id: 'ask-2', ownerId: owner.id, conversationId: 'chat-1', server: 'gpu-tools', why: 'again', status: 'requested', createdAt: now, updatedAt: now })
    expect(await listMcpRequests('chat-1')).toEqual(arrayWith([objectWith({ id: 'ask-1', status: 'requested' })]))
    expect(await enableMcpRequest('ask-1')).toEqual({ request: objectWith({ id: 'ask-1', status: anyOf(String) }), conversation: objectWith({ id: 'chat-1', mcpServers: ['gpu-tools'] }) })
    await expect(enableMcpRequest('ask-1')).rejects.toMatchObject({ response: { status: 409 } })
    expect(await dismissMcpRequest('ask-2')).toEqual({ request: objectWith({ id: 'ask-2', status: 'dismissed' }) })
    await expect(dismissMcpRequest('no-such-ask')).rejects.toMatchObject({ response: { status: 404, data: { error: 'Request not found' } } })
  })

  it('removes a server, after which the catalogue no longer has it', async () => {
    const server = (await getMcpCatalogue()).servers.find((entry) => entry.name === 'gpu-tools')!
    expect(await removeMcpServer(server.id)).toEqual({ removed: true })
    expect((await getMcpCatalogue()).servers.some((entry) => entry.name === 'gpu-tools')).toBe(false)
  })
})
