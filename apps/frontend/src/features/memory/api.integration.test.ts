import { describe, expect, it } from 'vitest'
import { approveMemory, createMemory, deleteMemory, getConsolidation, listMemories, promoteMemory, updateMemory } from './api'
import { startBackend } from '../../test/backend/site'
import { mountEngine } from '../../test/backend/engine'
import { anyOf, objectWith } from '../../../../backend/src/platform/lib/test-matchers'

const backend = await startBackend((site) => { mountEngine(site) })
const owner = await backend.signIn()

describe('the Memories page, as the browser asks for it', () => {
  it('starts with no memories', async () => {
    expect(await listMemories()).toEqual([])
  })

  it('makes a global memory the way the page sends it, and lists it', async () => {
    await createMemory({ category: 'environment_facts', scope: 'global', title: 'The GPU', text: 'The desk machine has two 3090s', status: 'active', model: 'qwen3-32b' })
    expect(await listMemories()).toEqual([objectWith({ id: anyOf(String), ownerId: owner.id, category: 'environment_facts', scope: 'global', status: 'active', source: 'manual', title: 'The GPU', text: 'The desk machine has two 3090s', model: 'qwen3-32b' })])
  })

  it('refuses a memory missing its words, and one of a kind there is none of', async () => {
    await expect(createMemory({ category: 'environment_facts', title: 'No text' })).rejects.toMatchObject({ response: { status: 400, data: { error: 'category, title, and text are required' } } })
    await expect(createMemory({ category: 'gossip', title: 'Odd', text: 'Odd' })).rejects.toMatchObject({ response: { status: 400, data: { error: 'gossip is not a kind of memory' } } })
  })

  it('saves an edit the way the page sends it, clearing the model with null', async () => {
    const [memory] = await listMemories()
    await updateMemory(memory!.id, { id: memory!.id, title: 'The GPUs', text: 'Two 3090s on the desk machine', category: 'environment_facts', scope: 'global', model: null })
    const [edited] = await listMemories()
    expect(edited).toEqual(objectWith({ id: memory!.id, title: 'The GPUs', text: 'Two 3090s on the desk machine' }))
    expect(edited?.model).toBeUndefined()
  })

  it('approves a memory waiting for review and makes a project memory global', async () => {
    await createMemory({ category: 'lessons_learned', scope: 'project', projectId: 'project-1', title: 'Waiting', text: 'Wait for review', status: 'pending_review' })
    const waiting = (await listMemories()).find((memory) => memory.title === 'Waiting')!
    expect(waiting.status).toBe('pending_review')
    await approveMemory(waiting.id)
    await promoteMemory(waiting.id)
    expect((await listMemories()).find((memory) => memory.id === waiting.id)).toEqual(objectWith({ status: 'active', scope: 'global' }))
  })

  it('deletes a memory, and answers 404 for one that is not there', async () => {
    const [memory] = await listMemories()
    await deleteMemory(memory!.id)
    expect((await listMemories()).some((one) => one.id === memory!.id)).toBe(false)
    await expect(deleteMemory(memory!.id)).rejects.toMatchObject({ response: { status: 404, data: { error: 'No such memory item' } } })
    await expect(approveMemory('no-such-memory')).rejects.toMatchObject({ response: { status: 404 } })
    await expect(promoteMemory('no-such-memory')).rejects.toMatchObject({ response: { status: 404 } })
    await expect(updateMemory('no-such-memory', { title: 'x', text: 'x', category: 'lessons_learned' })).rejects.toMatchObject({ response: { status: 404 } })
  })

  it('reads the last consolidation as nothing yet for the operator, and refuses it to anyone else', async () => {
    expect(await getConsolidation()).toBeNull()
    await backend.signInAnother('second@koala.test')
    await expect(getConsolidation()).rejects.toMatchObject({ response: { status: 403 } })
    expect(await listMemories()).toEqual([])
  })
})
