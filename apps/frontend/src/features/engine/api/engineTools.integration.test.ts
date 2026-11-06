import { describe, expect, expectTypeOf, it } from 'vitest'
import { type EngineTool, deleteEngineTool, listEngineTools, saveEngineTool } from './engineTools'
import { startBackend } from '../../../test/backend/site'
import { mountEngine } from '../../../test/backend/engine'
import type { Wire } from '../../../test/backend/wire'
import type { EditableTool } from '../../../../../backend/src/engine/services/EngineToolService'
import { anyOf, arrayWith, objectWith } from '../../../../../backend/src/platform/lib/test-matchers'

const backend = await startBackend((site) => { mountEngine(site) })
await backend.signIn()

const gpuTool: EngineTool = {
  name: 'gpu_status',
  summary: 'Says how busy the GPUs are.',
  binding: 'environment',
  effect: 'read',
  idempotent: true,
  openWorld: false,
  parameters: { type: 'object', properties: {} },
  returns: 'What nvidia-smi says.',
  failures: [{ when: 'there is no NVIDIA driver', says: 'nvidia-smi is not found' }],
  command: 'nvidia-smi',
  mine: true,
  grantedTo: [],
}

expectTypeOf<Wire<EditableTool>>().toExtend<EngineTool>()

describe('the Studio\'s tools, as the browser asks for them', () => {
  it('lists the built-in tools, each saying whether it is the person\'s and who holds it', async () => {
    const tools = await listEngineTools()
    expect(tools.length).toBeGreaterThan(0)
    expect(tools).toEqual(arrayWith([objectWith({ name: anyOf(String), mine: false, grantedTo: anyOf(Array) })]))
  })

  it('saves the person\'s own tool that runs a command, and lists it as theirs', async () => {
    expect(await saveEngineTool(gpuTool)).toEqual({ tool: objectWith({ name: 'gpu_status', command: 'nvidia-smi', mine: true, grantedTo: [] }), rebuilding: [], failed: [] })
    expect(await listEngineTools()).toEqual(arrayWith([objectWith({ name: 'gpu_status', mine: true })]))
  })

  it('refuses a tool nothing runs, with the problems the editor lists', async () => {
    const { command: _command, ...noCommand } = gpuTool
    await expect(saveEngineTool({ ...noCommand, name: 'gpu_nothing' })).rejects.toMatchObject({ response: { status: 400, data: { error: 'The tool does not hold together', problems: arrayWith([anyOf(String)]) } } })
  })

  it('refuses a tool that needs a dependency nobody has', async () => {
    await expect(saveEngineTool({ ...gpuTool, needs: ['no-such-dependency'] })).rejects.toMatchObject({ response: { status: 400, data: { problems: arrayWith([anyOf(String)]) } } })
  })

  it('deletes the person\'s own tool, and answers 404 when there is none to delete', async () => {
    await deleteEngineTool('gpu_status')
    expect((await listEngineTools()).some((tool) => tool.name === 'gpu_status')).toBe(false)
    await expect(deleteEngineTool('gpu_status')).rejects.toMatchObject({ response: { status: 404, data: { error: 'You have no copy of that tool to delete' } } })
  })
})
