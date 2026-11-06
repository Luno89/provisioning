import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  type TreeModelRow, type TreeRunStatus,
  cancelLeaf, createTree, deleteBranch, deleteLeaf, deleteTree, getTreeModels, getTreeRun, getTreeWorkspace, listBranches, listLeaves,
  listTreeTypes, listTrees, orderFeatures, orderStories, releaseTreeWorkspace, retryLeaf, runTree, setTreeModel, settleLeaf, stopTreeRun, updateTreeType,
} from './grove'
import type { Branch, Leaf, Tree, TreeType } from '../types/grove'
import { startBackend } from '../../../test/backend/site'
import { projectsOf, type ProjectsSide } from '../../../test/backend/projects'
import type { Wire } from '../../../test/backend/wire'
import { anyOf, objectWith } from '../../../../../backend/src/platform/lib/test-matchers'
import type { TreeTypeSpec } from '../../../../../backend/src/projects/lib/tree-types'
import type { Tree as BackendTree } from '../../../../../backend/src/projects/lib/trees'
import type { Branch as BackendBranch, Leaf as BackendLeaf } from '../../../../../backend/src/projects/lib/leaves'
import type { TreeModelRow as BackendModelRow } from '../../../../../backend/src/models/services/TreeModelsService'
import type { GroveRunStatus } from '../../../../../backend/src/infrastructure/services/TemporalBridge'
import { groveRunWorkflowId } from '../../../../../backend/src/engine-host/temporal/contracts'

let side: ProjectsSide | undefined

const backend = await startBackend(async (site) => { side = await projectsOf(site) })
const owner = await backend.signIn()
const now = new Date().toISOString()

expectTypeOf<Wire<BackendTree & { branchCount: number }>>().toExtend<Tree>()
expectTypeOf<Wire<BackendBranch>>().toExtend<Branch>()
expectTypeOf<Wire<BackendLeaf>>().toExtend<Leaf>()
expectTypeOf<Wire<TreeTypeSpec>>().toExtend<TreeType>()
expectTypeOf<Wire<BackendModelRow>>().toExtend<TreeModelRow>()
expectTypeOf<Wire<GroveRunStatus>>().toExtend<TreeRunStatus>()

describe('trees, features and stories, as the board asks for them', () => {
  let treeId = ''

  it('lists the shipped tree types the new tree dialog offers', async () => {
    const types = await listTreeTypes()
    expect(types.find((type) => type.id === 'research-paper')).toMatchObject({ id: 'research-paper', produces: 'artefact', label: anyOf(String) })
  })

  it('makes a tree the way the new tree dialog sends it, and lists it with no features', async () => {
    const made = await createTree<{ id: string; name: string; type: string }>({ name: 'GPU paper', type: 'research-paper', goal: 'Write up what the GPU can do' })
    expect(made).toMatchObject({ id: anyOf(String), name: 'GPU paper', type: 'research-paper', goal: 'Write up what the GPU can do', ownerId: owner.id, projectIds: [] })
    treeId = made.id
    expect(await listTrees()).toEqual([objectWith({ id: treeId, name: 'GPU paper', branchCount: 0 })])
  })

  it('refuses a tree with no name, and a type that does not exist with the types there are', async () => {
    await expect(createTree({ name: '', type: 'research-paper' })).rejects.toMatchObject({ response: { status: 400, data: { error: 'name and type are required' } } })
    await expect(createTree({ name: 'Odd', type: 'no-such-type' })).rejects.toMatchObject({ response: { status: 400, data: { error: 'There is no project type "no-such-type".' } } })
  })

  it('lists the features and stories a plan made, and stories of one feature', async () => {
    for (const id of ['feature-a', 'feature-b']) await backend.db.projects.saveBranch({ id, ownerId: owner.id, treeId, title: id, createdAt: now, updatedAt: now })
    await backend.db.projects.saveLeaf({ id: 'story-1', ownerId: owner.id, branchId: 'feature-a', title: 'Measure it', status: 'pending', createdAt: now, updatedAt: now })
    await backend.db.projects.saveLeaf({ id: 'story-2', ownerId: owner.id, branchId: 'feature-a', title: 'Write it', status: 'failed', createdAt: now, updatedAt: now })
    expect((await listBranches()).map((branch) => branch.id).sort()).toEqual(['feature-a', 'feature-b'])
    expect((await listLeaves()).map((leaf) => leaf.id).sort()).toEqual(['story-1', 'story-2'])
    expect((await listTrees())[0]).toMatchObject({ branchCount: 2 })
  })

  it('orders the features and the stories as dragged on the board', async () => {
    await orderFeatures(treeId, ['feature-b', 'feature-a'])
    await orderStories('feature-a', ['story-2', 'story-1'])
    const branches = await listBranches()
    expect(branches.find((branch) => branch.id === 'feature-b')!.priority!).toBeLessThan(branches.find((branch) => branch.id === 'feature-a')!.priority!)
    const leaves = await listLeaves()
    expect(leaves.find((leaf) => leaf.id === 'story-2')!.priority!).toBeLessThan(leaves.find((leaf) => leaf.id === 'story-1')!.priority!)
  })

  it('refuses an order naming a story that is not in the feature, or one story twice', async () => {
    await expect(orderStories('feature-a', ['story-1', 'story-9'])).rejects.toMatchObject({ response: { status: 400, data: { error: 'story-9 is not among the stories here' } } })
    await expect(orderStories('feature-a', ['story-1', 'story-1'])).rejects.toMatchObject({ response: { status: 400, data: { error: 'a story appears twice in the order' } } })
  })

  it('reads the tree\'s run as none before it ever ran, and its workspace as none', async () => {
    expect(await getTreeRun(treeId)).toEqual({ state: 'none' })
    expect(await getTreeWorkspace(treeId)).toEqual({ state: 'none' })
    expect(await releaseTreeWorkspace(treeId)).toEqual({ state: 'none' })
  })

  it('runs the tree, which starts its grove run, then stops it', async () => {
    const running = await runTree(treeId)
    expect(running).toMatchObject({ state: 'running', startedAt: anyOf(String) })
    expect(side!.temporal.workflows.get(groveRunWorkflowId(treeId))).toMatchObject({ workflowType: 'AgentRunWorkflow', status: 'RUNNING' })
    expect(await getTreeRun(treeId)).toMatchObject({ state: 'running' })
    expect(await stopTreeRun(treeId)).toMatchObject({ state: 'running' })
    expect(side!.temporal.workflows.get(groveRunWorkflowId(treeId))?.signals).toEqual([{ name: 'cancelRun', args: [] }])
  })

  it('lists each agent of the tree that asks a model, and refuses a model the person does not have', async () => {
    const rows = await getTreeModels(treeId)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0]).toMatchObject({ agent: anyOf(String), name: anyOf(String), own: anyOf(Object) })
    await expect(setTreeModel(treeId, rows[0]!.agent, 'no-such-model')).rejects.toMatchObject({ response: { status: 400, data: { error: anyOf(String) } } })
    await expect(setTreeModel(treeId, '', null)).rejects.toMatchObject({ response: { status: 400, data: { error: 'say which agent, as "agent"' } } })
  })

  it('cancels an unfinished story and refuses to cancel it again', async () => {
    expect(await cancelLeaf('story-1')).toMatchObject({ id: 'story-1', status: 'cancelled' })
    await expect(cancelLeaf('story-1')).rejects.toMatchObject({ response: { status: 409, data: { error: 'Only unfinished work can be cancelled; this leaf is cancelled.' } } })
  })

  it('refuses to settle a story nobody claimed, and a verdict that is neither', async () => {
    await expect(settleLeaf('story-2', 'verified')).rejects.toMatchObject({ response: { status: 409 } })
    await expect(settleLeaf('story-2', 'maybe' as 'verified')).rejects.toMatchObject({ response: { status: 400, data: { error: 'verdict is \'verified\' or \'failed\'' } } })
  })

  it('retries a failed story, putting it back in line', async () => {
    expect(await retryLeaf('story-2')).toMatchObject({ id: 'story-2', status: 'pending' })
    await expect(retryLeaf('story-2')).rejects.toMatchObject({ response: { status: 409, data: { error: 'Only a failed leaf can be retried; this one is pending.' } } })
  })

  it('deletes a story, which stops the tree\'s run, and then a feature', async () => {
    expect(await deleteLeaf('story-2')).toMatchObject({ success: true, stoppedRun: true })
    expect(side!.temporal.workflows.get(groveRunWorkflowId(treeId))?.status).toBe('CANCELLED')
    expect(await deleteBranch('feature-b')).toMatchObject({ success: true, stoppedRun: false })
    expect((await listBranches()).map((branch) => branch.id)).toEqual(['feature-a'])
  })

  it('answers 404 to another person for the tree, its features and stories', async () => {
    await backend.signInAnother('second@koala.test')
    expect(await listTrees()).toEqual([])
    expect(await listLeaves()).toEqual([])
    await expect(getTreeRun(treeId)).rejects.toMatchObject({ response: { status: 404 } })
    await expect(runTree(treeId)).rejects.toMatchObject({ response: { status: 404 } })
    await expect(getTreeModels(treeId)).rejects.toMatchObject({ response: { status: 404, data: { error: 'Tree not found' } } })
    await expect(orderFeatures(treeId, ['feature-a'])).rejects.toMatchObject({ response: { status: 404, data: { error: 'Tree not found' } } })
    await expect(cancelLeaf('story-1')).rejects.toMatchObject({ response: { status: 404, data: { error: 'Leaf not found' } } })
    await expect(deleteBranch('feature-a')).rejects.toMatchObject({ response: { status: 404 } })
    await expect(deleteTree(treeId)).rejects.toMatchObject({ response: { status: 404, data: { error: 'Tree not found' } } })
    await backend.signIn()
  })

  it('deletes the tree with everything in it', async () => {
    expect(await deleteTree(treeId)).toMatchObject({ success: true, stoppedRun: false })
    expect(await listTrees()).toEqual([])
    expect(await listBranches()).toEqual([])
  })
})

describe('tree types', () => {
  it('saves the person\'s own copy of a shipped type, and the list then carries theirs once', async () => {
    const [shipped] = (await listTreeTypes()).filter((type) => type.id === 'research-paper')
    const saved = await updateTreeType('research-paper', { ...shipped!, summary: 'Our own papers' })
    expect(saved).toMatchObject({ id: 'research-paper', ownerId: owner.id, summary: 'Our own papers' })
    expect((await listTreeTypes()).filter((type) => type.id === 'research-paper')).toEqual([objectWith({ summary: 'Our own papers' })])
  })

  it('refuses a type whose agent does not exist', async () => {
    const [shipped] = (await listTreeTypes()).filter((type) => type.id === 'research-paper')
    await expect(updateTreeType('research-paper', { ...shipped!, agent: 'nobody-agent' })).rejects.toMatchObject({ response: { status: 400, data: { error: anyOf(String) } } })
  })
})
