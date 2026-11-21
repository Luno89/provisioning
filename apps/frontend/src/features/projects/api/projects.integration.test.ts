import { describe, expect, expectTypeOf, it } from 'vitest'
import { createProject, deleteProject, getProjectRemoval, listProjectRuns, listProjects, patchProject, promoteRun } from './projects'
import { getProjectChannel, postChannelMessage, type ProjectChannel } from './project-channel'
import { openItemChat } from './item-chats'
import { approvePlan, listPlans, listTreePlans, rejectPlan } from './plans'
import { dismissSecretRequest, listConversationSecretRequests, listTreeSecretRequests, submitSecret } from './secret-requests'
import type { ProjectRemovalPreview, ProjectRemovalState } from '../types/project-removal'
import { startBackend } from '../../../test/backend/site'
import { projectsOf, type ProjectsSide } from '../../../test/backend/projects'
import type { Wire } from '../../../test/backend/wire'
import { anyOf, objectWith } from '../../../../../backend/src/platform/lib/test-matchers'
import { deleteProjectWorkflowId, type ProjectRemovalPreview as BackendPreview } from '../../../../../backend/src/projects/lib/project-removal'
import type { ProjectRemovalState as BackendState } from '../../../../../backend/src/projects/services/ProjectRemovalService'

let side: ProjectsSide | undefined

const backend = await startBackend(async (site) => { side = await projectsOf(site) })
const owner = await backend.signIn()
const desk = await side!.machines.join('desk', (await side!.machines.accounts.createJoinCode(owner.id)).code)
const now = new Date().toISOString()

expectTypeOf<Wire<BackendPreview & { state: BackendState }>>().toExtend<ProjectRemovalPreview>()
expectTypeOf<Wire<BackendState>>().toExtend<ProjectRemovalState>()

describe('a project, as the projects pages ask for it', () => {
  let projectId = ''

  it('registers a project that runs on one of the person\'s machines the way the new project dialog sends it', async () => {
    const made = await createProject({ name: 'Desk work', executionApproval: 'plan', executionTargetDeviceId: desk, executionTargetPath: 'work' })
    expect(made).toMatchObject({ id: anyOf(String), name: 'Desk work', ownerId: owner.id, appType: 'local', executionApproval: 'plan', executionTarget: { kind: 'local-device', deviceId: desk, path: 'work' } })
    projectId = made.id
  })

  it('refuses a project with no name, one on a machine that is not the person\'s, and a second project on the same machine folder', async () => {
    await expect(createProject({ executionTargetDeviceId: desk })).rejects.toMatchObject({ response: { status: 400, data: { error: 'name is required' } } })
    await expect(createProject({ name: 'Elsewhere', executionTargetDeviceId: 'not-mine' })).rejects.toMatchObject({ response: { status: 400, data: { error: 'Unknown local execution device' } } })
    await expect(createProject({ name: 'Twice', executionTargetDeviceId: desk, executionTargetPath: 'work' })).rejects.toMatchObject({ response: { status: 409, data: { error: 'That machine (at that path) is already the execution target for another project.' } } })
    await expect(createProject({ name: 'Somewhere', giteaRepo: 'somewhere', targetClusterId: 'no-such-cluster' })).rejects.toMatchObject({ response: { status: 400, data: { error: 'Deploy to one of your own clusters.' } } })
  })

  it('lists the project beside the one its machine was added with, each with its status rolled up', async () => {
    const listed = await listProjects<{ id: string; name: string; status?: string }>()
    expect(listed).toHaveLength(2)
    expect(listed.find((project) => project.id === projectId)).toMatchObject({ name: 'Desk work', status: 'no-build' })
  })

  it('changes how its work is approved and reads the project back', async () => {
    expect(await patchProject(projectId, { executionApproval: 'auto' })).toMatchObject({ id: projectId, executionApproval: 'auto' })
  })

  it('lists no builds for a project that has none, and refuses to promote a build it does not have', async () => {
    expect(await listProjectRuns(projectId)).toEqual([])
    await expect(promoteRun(projectId, 'no-run')).rejects.toMatchObject({ response: { status: 404, data: { error: 'Run not found' } } })
  })

  it('opens the project\'s channel, made the first time it is asked for, with no threads yet', async () => {
    const channel: ProjectChannel = await getProjectChannel(projectId)
    expect(channel).toEqual({ channel: { id: `channel-${projectId}`, title: anyOf(String) }, threads: [] })
  })

  it('posts a message in the channel without starting a turn, and it is there when the channel is read', async () => {
    const { channel } = await getProjectChannel(projectId)
    await postChannelMessage(channel.id, 'Is the desk free tonight?')
    const read = await backend.db.engine.getConversation(owner.id, channel.id)
    expect(read?.messages.at(-1)).toMatchObject({ role: 'user', content: 'Is the desk free tonight?' })
  })

  it('refuses an empty channel post', async () => {
    const { channel } = await getProjectChannel(projectId)
    await expect(postChannelMessage(channel.id, '')).rejects.toMatchObject({ response: { status: 400 } })
  })

  it('previews what deleting the project takes, with nothing running yet', async () => {
    expect(await getProjectRemoval(projectId)).toMatchObject({ name: 'Desk work', trees: [], keptConversations: anyOf(Number), builds: 0, apps: [], state: { state: 'none' } })
  })

  it('refuses a delete whose typed name is wrong, and starts the removal when it is right', async () => {
    await expect(deleteProject(projectId, 'Desk wrk')).rejects.toMatchObject({ response: { status: 400 } })
    expect(await deleteProject(projectId, 'Desk work')).toEqual({ state: 'running', done: [] })
    expect(side!.temporal.workflows.get(deleteProjectWorkflowId(projectId))).toMatchObject({ status: 'RUNNING', args: [{ projectId }] })
  })

  it('refuses a change to the project once its deletion has started, in the words the person reads, and still shows the deletion', async () => {
    await expect(patchProject(projectId, { executionApproval: 'auto' })).rejects.toMatchObject({ response: { status: 409, data: { error: 'this project is being deleted' } } })
    expect(await getProjectRemoval(projectId)).toMatchObject({ name: 'Desk work', state: { state: 'running' } })
  })

  it('answers 404 to another person for every project route', async () => {
    await backend.signInAnother('second@koala.test')
    expect(await listProjects()).toEqual([])
    await expect(patchProject(projectId, { executionApproval: 'plan' })).rejects.toMatchObject({ response: { status: 404, data: { error: 'Project not found' } } })
    await expect(listProjectRuns(projectId)).rejects.toMatchObject({ response: { status: 404 } })
    await expect(getProjectChannel(projectId)).rejects.toMatchObject({ response: { status: 404 } })
    await expect(getProjectRemoval(projectId)).rejects.toMatchObject({ response: { status: 404 } })
    await expect(postChannelMessage(`channel-${projectId}`, 'hello')).rejects.toMatchObject({ response: { status: 404 } })
    await backend.signIn()
  })
})

describe('a story\'s and a feature\'s chat', () => {
  it('opens the chat of a story and of a feature, the same one each time', async () => {
    await backend.db.projects.saveTree({ id: 'tree-chat', ownerId: owner.id, name: 'Chatty', type: 'research-paper', createdAt: now, updatedAt: now })
    await backend.db.projects.saveBranch({ id: 'branch-chat', ownerId: owner.id, treeId: 'tree-chat', title: 'A feature', createdAt: now, updatedAt: now })
    await backend.db.projects.saveLeaf({ id: 'leaf-chat', ownerId: owner.id, branchId: 'branch-chat', title: 'A story', status: 'pending', createdAt: now, updatedAt: now })
    const story = await openItemChat('story', 'leaf-chat')
    expect(story).toEqual({ id: 'story-leaf-chat', title: anyOf(String) })
    expect(await openItemChat('story', 'leaf-chat')).toEqual(story)
    expect(await openItemChat('feature', 'branch-chat')).toEqual({ id: 'feature-branch-chat', title: anyOf(String) })
  })

  it('answers 404 for a story that does not exist', async () => {
    await expect(openItemChat('story', 'no-such-leaf')).rejects.toMatchObject({ response: { status: 404, data: { error: 'No such story' } } })
  })
})

describe('plan cards', () => {
  const proposal = (id: string) => ({ id, ownerId: owner.id, conversationId: 'conversation-plans', status: 'proposed' as const, plan: { treeId: 'tree-chat', planDoc: '# Plan', branches: [] }, createdAt: now, updatedAt: now })

  it('lists a conversation\'s and a tree\'s plans', async () => {
    await backend.db.projects.savePlanProposal(proposal('plan-one'))
    await backend.db.projects.savePlanProposal(proposal('plan-two'))
    expect((await listPlans('conversation-plans')).map((plan) => plan.id).sort()).toEqual(['plan-one', 'plan-two'])
    expect((await listTreePlans('tree-chat')).map((plan) => plan.id).sort()).toEqual(['plan-one', 'plan-two'])
  })

  it('approves a plan, which starts its adoption, and refuses to approve it twice', async () => {
    expect(await approvePlan('plan-one')).toMatchObject({ id: 'plan-one', status: 'adopting' })
    expect(side!.temporal.workflows.get('adopt-plan-plan-one')).toMatchObject({ workflowType: 'AdoptPlanWorkflow', args: [{ ownerId: owner.id, proposalId: 'plan-one' }] })
    await expect(approvePlan('plan-one')).rejects.toMatchObject({ response: { status: 409 } })
  })

  it('rejects a plan with the reason the person gave', async () => {
    expect(await rejectPlan('plan-two', 'not now')).toMatchObject({ id: 'plan-two', status: 'rejected', reason: 'not now' })
  })

  it('answers 404 for a plan that is not the person\'s', async () => {
    await expect(approvePlan('nobody-plan')).rejects.toMatchObject({ response: { status: 404, data: { error: 'Plan not found' } } })
    await expect(rejectPlan('nobody-plan')).rejects.toMatchObject({ response: { status: 404 } })
  })
})

describe('secrets Koala asks the person for', () => {
  const request = (id: string) => ({ id, ownerId: owner.id, projectId: 'project-secret', key: 'API_KEY', description: 'the payment provider\'s key', secretReference: 'secret://project-secret/API_KEY', status: 'requested' as const, conversationId: 'conversation-secrets', treeId: 'tree-chat', createdAt: now, updatedAt: now })

  it('lists the requests of a conversation and of a tree', async () => {
    await backend.db.projects.saveSecretRequest(request('secret-one'))
    expect(await listConversationSecretRequests('conversation-secrets')).toEqual([objectWith({ id: 'secret-one', key: 'API_KEY', status: 'requested' })])
    expect(await listTreeSecretRequests('tree-chat')).toEqual([objectWith({ id: 'secret-one' })])
  })

  it('refuses an empty secret before anything is stored', async () => {
    await expect(submitSecret('secret-one', '')).rejects.toMatchObject({ response: { status: 400 } })
  })

  it('dismisses a request, after which it cannot be dismissed again', async () => {
    expect(await dismissSecretRequest('secret-one')).toMatchObject({ id: 'secret-one', status: 'dismissed' })
    await expect(dismissSecretRequest('secret-one')).rejects.toMatchObject({ response: { status: 409, data: { error: 'This request is already dismissed.' } } })
  })

  it('answers 404 for a request that is not the person\'s', async () => {
    await expect(dismissSecretRequest('nobody-secret')).rejects.toMatchObject({ response: { status: 404, data: { error: 'Secret request not found' } } })
  })
})
