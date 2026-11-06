import { describe, expect, expectTypeOf, it } from 'vitest'
import { type Agent, deleteAgent, getAgent, listAgents, listGrantableTools, saveAgent } from './agents'
import { startBackend } from '../../../test/backend/site'
import { mountEngine } from '../../../test/backend/engine'
import type { Wire } from '../../../test/backend/wire'
import type { EditableAgent } from '../../../../../backend/src/engine/services/AgentService'
import { anyOf, arrayWith, objectWith } from '../../../../../backend/src/platform/lib/test-matchers'

const backend = await startBackend((site) => { mountEngine(site) })
await backend.signIn()

expectTypeOf<Wire<EditableAgent>>().toExtend<Agent>()

describe('the Studio\'s agents, as the browser asks for them', () => {
  it('lists the built-in agents, Koala among them, not the person\'s own', async () => {
    const agents = await listAgents()
    expect(agents).toEqual(arrayWith([objectWith({ slug: 'koala', mine: false, procedure: anyOf(String) })]))
    expect(agents.every((agent) => Array.isArray(agent.tools) && typeof agent.prompt === 'string')).toBe(true)
  })

  it('lists the tools an agent can be granted with the languages a workspace can have', async () => {
    const grantable = await listGrantableTools()
    expect(grantable.tools.length).toBeGreaterThan(0)
    expect(grantable.tools[0]).toEqual(objectWith({ name: anyOf(String), summary: anyOf(String), binding: anyOf(String), effect: anyOf(String) }))
    expect(grantable.languages.length).toBeGreaterThan(0)
  })

  it('reads one agent, and answers 404 for one that does not exist', async () => {
    expect(await getAgent('koala')).toEqual(objectWith({ slug: 'koala', name: anyOf(String) }))
    await expect(getAgent('nobody-at-all')).rejects.toMatchObject({ response: { status: 404, data: { error: 'There is no agent with that slug' } } })
  })

  it('saves the person\'s own agent and reads it back as theirs', async () => {
    const koala = await getAgent('koala')
    const saved = await saveAgent({ ...koala, slug: 'helper', name: 'Helper', description: 'Helps with the GPU machine', usedBy: [] })
    expect(saved).toEqual(objectWith({ slug: 'helper', name: 'Helper', description: 'Helps with the GPU machine' }))
    expect(await getAgent('helper')).toEqual(objectWith({ slug: 'helper', mine: true }))
  })

  it('refuses an agent that names a tool nobody has, with the problems the editor lists', async () => {
    const helper = await getAgent('helper')
    await expect(saveAgent({ ...helper, tools: ['no_such_tool_anywhere'] })).rejects.toMatchObject({ response: { status: 400, data: { error: 'The agent does not hold together', problems: arrayWith([anyOf(String)]) } } })
  })

  it('deletes the person\'s own agent, and answers 404 when there is no copy to delete', async () => {
    await deleteAgent('helper')
    await expect(getAgent('helper')).rejects.toMatchObject({ response: { status: 404 } })
    await expect(deleteAgent('helper')).rejects.toMatchObject({ response: { status: 404, data: { error: 'You have no copy of that agent to delete' } } })
  })
})
