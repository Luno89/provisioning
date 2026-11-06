import { describe, expect, expectTypeOf, it } from 'vitest'
import { type EngineTask, type ExtensionSummary, acceptTask, approveRunCall, createExtension, deleteExtension, dropTask, listExtensions, listTasks, removeOperation, setExtensionEnabled, updateExtension } from './engine'
import { startBackend } from '../../../test/backend/site'
import { mountEngine } from '../../../test/backend/engine'
import type { Wire } from '../../../test/backend/wire'
import type { Task } from '../../../../../backend/src/projects/lib/tasks'
import type { extensionSummary } from '../../../../../backend/src/engine/routes/engine'
import { anyOf, arrayWith, objectWith } from '../../../../../backend/src/platform/lib/test-matchers'

const backend = await startBackend((site) => { mountEngine(site) })
const owner = await backend.signIn()
const now = new Date().toISOString()
const task = (id: string, over: Partial<Task> = {}): Task => ({ id, ownerId: owner.id, title: id, doneMeans: 'it answers', dependsOn: [], status: 'proposed', runs: [], createdAt: now, updatedAt: now, ...over })
await backend.db.projects.saveTask(task('serve-model'))
await backend.db.projects.saveTask(task('chat-on-it', { dependsOn: ['serve-model'] }))

describe('the shapes the browser reads are the shapes the backend sends', () => {
  it('reads a task and an extension as the backend describes them', () => {
    expectTypeOf<Wire<Task & { ready: boolean; waitingOn: { id: string; title: string; status: Task['status'] }[] }>>().toExtend<EngineTask>()
    expectTypeOf<Wire<ReturnType<typeof extensionSummary>>>().toExtend<ExtensionSummary>()
  })
})

describe('tasks, as the browser lists and decides them', () => {
  it('lists the person\'s tasks with what each waits on', async () => {
    const tasks = await listTasks()
    expect(tasks).toEqual(arrayWith([
      objectWith({ id: 'serve-model', status: 'proposed', waitingOn: [] }),
      objectWith({ id: 'chat-on-it', waitingOn: [{ id: 'serve-model', title: 'serve-model', status: 'proposed' }] }),
    ]))
  })

  it('accepts one and drops another, and answers 404 for a task that does not exist', async () => {
    await acceptTask('serve-model')
    await dropTask('chat-on-it')
    expect((await listTasks()).map((one) => [one.id, one.status]).sort()).toEqual([['chat-on-it', 'dropped'], ['serve-model', 'accepted']])
    await expect(acceptTask('no-such-task')).rejects.toMatchObject({ response: { status: 404, data: { error: 'No such task' } } })
  })
})

describe('extensions, as the Studio asks for them', () => {
  it('lists the installed extensions with whether each is on', async () => {
    expect(await listExtensions()).toEqual(arrayWith([objectWith({ id: anyOf(String), enabled: anyOf(Boolean), alwaysOn: anyOf(Boolean), tools: anyOf(Array), operations: anyOf(Array) })]))
  })

  it('makes the person\'s own extension, switches it off and on, renames it, and deletes it', async () => {
    expect(await createExtension({ id: 'gpu-kit', title: 'GPU kit', describe: 'What I use on my GPU machine' })).toEqual(arrayWith([objectWith({ id: 'gpu-kit', title: 'GPU kit', authored: true, enabled: true })]))
    expect((await setExtensionEnabled('gpu-kit', false)).find((extension) => extension.id === 'gpu-kit')?.enabled).toBe(false)
    expect((await setExtensionEnabled('gpu-kit', true)).find((extension) => extension.id === 'gpu-kit')?.enabled).toBe(true)
    expect(await updateExtension('gpu-kit', { title: 'My GPU kit' })).toEqual(arrayWith([objectWith({ id: 'gpu-kit', title: 'My GPU kit' })]))
    await expect(removeOperation('gpu-kit', 'no-such-operation')).rejects.toMatchObject({ response: { status: 404, data: { error: anyOf(String) } } })
    expect((await deleteExtension('gpu-kit')).some((extension) => extension.id === 'gpu-kit')).toBe(false)
  })

  it('refuses to switch off an extension that is always on, and one that does not exist', async () => {
    const always = (await listExtensions()).find((extension) => extension.alwaysOn)
    expect(always).toEqual(objectWith({ alwaysOn: true }))
    await expect(setExtensionEnabled(always!.id, false)).rejects.toMatchObject({ response: { status: 409, data: { error: anyOf(String) } } })
    await expect(setExtensionEnabled('no-such-extension', false)).rejects.toMatchObject({ response: { status: 404, data: { error: anyOf(String) } } })
  })

  it('refuses an extension whose id is taken', async () => {
    const [installed] = await listExtensions()
    await expect(createExtension({ id: installed!.id, title: 'Mine' })).rejects.toMatchObject({ response: { status: 400, data: { error: anyOf(String) } } })
  })
})

describe('answering a run that asks before a call', () => {
  it('answers 404 for a run that is not the person\'s', async () => {
    await expect(approveRunCall('run-of-nobody', { callId: 'call-1', allowed: true })).rejects.toMatchObject({ response: { status: 404, data: { error: 'You have no run with that id' } } })
  })
})
