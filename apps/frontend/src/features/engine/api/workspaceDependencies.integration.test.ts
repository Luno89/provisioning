import { describe, expect, it } from 'vitest'
import { listDependencies, removeDependency, saveDependency } from './workspaceDependencies'
import { saveEngineTool } from './engineTools'
import { startBackend } from '../../../test/backend/site'
import { mountEngine } from '../../../test/backend/engine'
import { anyOf, arrayWith, objectWith } from '../../../../../backend/src/platform/lib/test-matchers'

const backend = await startBackend((site) => { mountEngine(site) })
await backend.signIn()

const nvtop = { name: 'nvtop', summary: 'Watches the GPUs.', provides: ['nvtop'], install: [{ via: 'apt' as const, packages: ['nvtop'] }] }

describe('workspace dependencies, as the Studio asks for them', () => {
  it('lists the dependencies Koala ships, none of them the person\'s, each saying who uses it', async () => {
    const listed = await listDependencies()
    expect(listed).toEqual(arrayWith([objectWith({ name: 'node', mine: false, script: false, usedBy: objectWith({ tools: arrayWith([]), trees: [] }) })]))
  })

  it('saves the person\'s own dependency and lists it as theirs', async () => {
    expect(await saveDependency(nvtop)).toEqual(objectWith({ name: 'nvtop', mine: true, script: false, provides: ['nvtop'], usedBy: { tools: [], servers: [], dependencies: [], steps: [], trees: [] } }))
    expect(await listDependencies()).toEqual(arrayWith([objectWith({ name: 'nvtop', mine: true })]))
  })

  it('marks a dependency that installs by script as one', async () => {
    expect(await saveDependency({ ...nvtop, name: 'nvtop-script', install: [{ via: 'script', run: 'apt-get install -y nvtop' }] })).toEqual(objectWith({ name: 'nvtop-script', script: true }))
  })

  it('refuses a dependency that names nothing it provides, with the reason', async () => {
    await expect(saveDependency({ ...nvtop, name: 'empty', provides: [] })).rejects.toMatchObject({ response: { status: 400, data: { problems: arrayWith([anyOf(String)]) } } })
  })

  it('refuses to remove a dependency a tool still needs, saying which, and removes it once nothing does', async () => {
    await saveEngineTool({ name: 'gpu_watch', summary: 'Watches the GPUs.', binding: 'environment', effect: 'read', idempotent: true, openWorld: false, parameters: { type: 'object', properties: {} }, returns: 'nvtop output.', failures: [{ when: 'nvtop is missing', says: 'nvtop is not found' }], command: 'nvtop -s', needs: ['nvtop'], mine: true, grantedTo: [] })
    expect(await listDependencies()).toEqual(arrayWith([objectWith({ name: 'nvtop', usedBy: objectWith({ tools: ['gpu_watch'] }) })]))
    await expect(removeDependency('nvtop')).rejects.toMatchObject({ response: { status: 409, data: { error: 'nvtop is still needed by the tool gpu_watch' } } })
    await removeDependency('nvtop-script')
    expect((await listDependencies()).some((dependency) => dependency.name === 'nvtop-script')).toBe(false)
  })

  it('refuses to remove one Koala ships', async () => {
    await expect(removeDependency('node')).rejects.toMatchObject({ response: { status: 409, data: { error: 'node is one Koala ships' } } })
  })
})
