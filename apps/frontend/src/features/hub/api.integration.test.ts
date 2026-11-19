import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  acceptInvitation, changeMemberRole, checkGroup, deleteSharedProject, getHubBoard, getInvitation, getRootInvitation, getSharedProject, getSharing,
  hubElsewhere, inviteToProject, listSharedProjects, removeMember, takeInviteBack,
} from './api'
import type { GroupCheck, RootInvitation, SharedProject, SharedProjectView, SharingPreview } from './types'
import { startBackend } from '../../test/backend/site'
import { outsideThisTier } from '../../test/backend/outside'
import type { Wire } from '../../test/backend/wire'
import { anyOf, arrayWith, containing, objectWith } from '../../../../backend/src/platform/lib/test-matchers'
import { hubRouter } from '../../../../backend/src/hub/routes/hub'
import { hubLinkRouter } from '../../../../backend/src/hub/routes/hub-link'
import { projectSharingRouter } from '../../../../backend/src/hub/routes/project-sharing'
import { HubService, type ProjectView } from '../../../../backend/src/hub/services/HubService'
import { HubRelay } from '../../../../backend/src/hub/services/HubRelay'
import { ProjectInviteService } from '../../../../backend/src/hub/services/ProjectInviteService'
import { mongoHubStore } from '../../../../backend/src/hub/store'
import type { SharedProject as BackendSharedProject } from '../../../../backend/src/hub/lib/hub'
import { localHubSharing, localProjectGroups } from '../../../../backend/src/projects/testing/in-process-sharing'
import { ProjectSharingService, type GroupCheck as BackendGroupCheck, type SharingPreview as BackendSharingPreview } from '../../../../backend/src/projects/services/ProjectSharingService'
import { hashCredential } from '../../../../backend/src/instances/services/InstanceService'
import { principalOf } from '../../../../backend/src/platform/lib/permissions'
import { mongoTarget } from '../../../../backend/src/platform/lib/mongo-db'
import { DATA_KEY } from '../../test/backend/machines'

const created: { hub?: HubService } = {}

const backend = await startBackend(async ({ api, db, origin }) => {
  const invites = new ProjectInviteService({ invites: db.accounts, people: db.accounts, principalFor: (user) => principalOf(user, { role: 'root' }), limits: () => db.accounts.getInviteLimits(), rootUrl: origin })
  const store = mongoHubStore(mongoTarget(process.env).uri, `${mongoTarget(process.env).dbName}_hub`)
  await store.init()
  const hub = new HubService({ store, invites, relay: new HubRelay() })
  created.hub = hub
  api.use('/hub-link', hubLinkRouter({ invites, hash: hashCredential, signInKeys: { get: () => db.instances.getHubSignInKey(), save: (key) => db.instances.saveHubSignInKey(key) }, people: db.accounts }))
  api.use('/hub', hubRouter({ hub }))
  api.use('/project-sharing', projectSharingRouter({
    sharing: new ProjectSharingService({
      store: db,
      sharing: localHubSharing(hub, 'i1'),
      sync: outsideThisTier('hub sync, which pushes to Gitea'),
      dataKey: DATA_KEY,
      ownerRepo: async () => { throw new Error('the owner\'s repository is in Gitea, outside this tier') },
      notify: async () => undefined,
      groups: localProjectGroups(db),
      republish: async () => undefined,
      domain: 'people.koala.test',
    }),
  }))
})

const owner = await backend.signIn('ann@koala.test')
await backend.db.projects.saveProjectInfo({ id: 'p-shop', name: 'Shop', ownerId: owner.id, createdAt: new Date().toISOString() } as never)
const made = await created.hub!.share({ kind: 'instance', personId: owner.id, instanceId: 'i1', email: 'ann@koala.test' }, { name: 'Shop', projectId: 'p-shop' })
if (!made.ok) throw new Error(made.why)
const SHARED = made.value.view.project.id
let join = ''
let cyId = ''

expectTypeOf<Wire<BackendSharedProject>>().toExtend<SharedProject>()
expectTypeOf<Wire<ProjectView>>().toExtend<SharedProjectView>()
expectTypeOf<Wire<BackendSharingPreview>>().toExtend<SharingPreview>()
expectTypeOf<Wire<BackendGroupCheck>>().toExtend<GroupCheck>()
expectTypeOf<Wire<NonNullable<Awaited<ReturnType<ProjectInviteService['invitation']>>>>>().toExtend<RootInvitation>()

describe('projects shared between people', () => {
  it('lists the shared project as its owner\'s, with everything an owner may do', async () => {
    expect(await listSharedProjects()).toEqual([{ project: objectWith({ id: SHARED, name: 'Shop', createdBy: owner.id }), role: 'owner' }])
    expect(await getSharedProject(SHARED)).toEqual(objectWith({ project: objectWith({ id: SHARED }), role: 'owner', can: anyOf(Array), members: [objectWith({ personId: owner.id, email: 'ann@koala.test', role: 'owner' })] }))
  })

  it('previews sharing a project of the owner\'s own, saying what goes and what stays, and checks a group name', async () => {
    expect(await getSharing('p-shop')).toEqual({ canShare: true, addresses: { scope: 'owner' }, moves: { epics: 0, features: 0, stories: 0, tasks: 0, chats: 0 }, stays: ['your other chats with Koala', 'the project\'s secrets', 'its builds and releases, which still run on your instance', 'the deployed app and its clusters'] })
    expect(await checkGroup('p-shop', '')).toEqual({ ok: false, suggested: 'shop' })
    expect(await checkGroup('p-shop', 'Not-A-Group')).toEqual(objectWith({ ok: false, problem: anyOf(String), suggested: 'shop' }))
    await expect(getSharing('nobody')).rejects.toMatchObject({ response: { status: 404, data: { error: 'There is no such project.' } } })
  })

  it('invites someone by email as a client, with the link root makes for them', async () => {
    const sent = await inviteToProject(SHARED, { email: 'cy@koala.test', role: 'client' })
    expect(sent).toEqual({ email: 'cy@koala.test', role: 'client', link: containing(`${backend.origin}/#/join?code=`), emailed: false, why: anyOf(String) })
    const link = new URL(sent.link.replace('/#/', '/'))
    join = link.searchParams.get('project') ?? ''
    const invitation = await getRootInvitation(link.searchParams.get('code') ?? '')
    expect(invitation).toEqual({ email: 'cy@koala.test', project: { name: 'Shop', role: 'client', join }, used: false })
    expect(await getInvitation(join)).toEqual({ projectName: 'Shop', role: 'client', email: 'cy@koala.test', forYou: false })
    await expect(getRootInvitation('no-such-code')).rejects.toMatchObject({ response: { status: 404, data: { error: 'This invite does not exist; ask for a new one.' } } })
  })

  it('takes an invite back and sends it again', async () => {
    expect(await takeInviteBack(SHARED, 'cy@koala.test')).toEqual({ email: 'cy@koala.test' })
    const again = await inviteToProject(SHARED, { email: 'cy@koala.test', role: 'client' })
    join = new URL(again.link.replace('/#/', '/')).searchParams.get('project') ?? ''
  })

  it('reads the board of a project whose owner\'s instance is not connected', async () => {
    expect(await getHubBoard(SHARED)).toEqual(objectWith({ project: objectWith({ id: SHARED }), role: 'owner', online: false, chats: [], requests: [] }))
  })

  it('lets the person invited in as a client, who may not invite or change roles', async () => {
    cyId = (await backend.signInAnother('cy@koala.test')).id
    expect(await getInvitation(join)).toEqual(objectWith({ forYou: true }))
    expect(await acceptInvitation(join)).toEqual(objectWith({ role: 'client', can: ['see-project', 'see-people', 'pin-and-comment', 'ask-koala'] }))
    expect(await listSharedProjects()).toEqual([{ project: objectWith({ id: SHARED }), role: 'client' }])
    await expect(inviteToProject(SHARED, { email: 'dee@koala.test', role: 'owner' })).rejects.toMatchObject({ response: { status: 403 } })
    await expect(changeMemberRole(SHARED, cyId, 'owner')).rejects.toMatchObject({ response: { status: 403 } })
    await expect(getSharing('p-shop')).rejects.toMatchObject({ response: { status: 404 } })
  })

  it('shows someone not on the project nothing of it', async () => {
    await backend.signInAnother('eve@koala.test')
    expect(await listSharedProjects()).toEqual([])
    await expect(getSharedProject(SHARED)).rejects.toMatchObject({ response: { status: 404 } })
    await expect(acceptInvitation(join)).rejects.toMatchObject({ response: { status: 404 } })
  })

  it('lets the owner change a member\'s role, remove them and delete the project once its name is typed', async () => {
    await backend.signIn('ann@koala.test')
    expect(await changeMemberRole(SHARED, cyId, 'collaborator')).toEqual(objectWith({ members: anyOf(Array) }))
    expect((await getSharedProject(SHARED)).members).toEqual(arrayWith([objectWith({ personId: cyId, role: 'collaborator' })]))
    expect(await removeMember(SHARED, cyId)).toEqual({ removed: cyId })
    await expect(deleteSharedProject(SHARED, 'wrong')).rejects.toMatchObject({ response: { status: 400 } })
    expect(await deleteSharedProject(SHARED, 'Shop')).toEqual({ deleted: SHARED })
    expect(await listSharedProjects()).toEqual([])
  })

  it('names no hub elsewhere where the hub runs in this same Koala', async () => {
    expect(await hubElsewhere()).toBeNull()
  })
})
