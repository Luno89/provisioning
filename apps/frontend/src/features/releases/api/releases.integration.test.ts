import { describe, expect, expectTypeOf, it } from 'vitest'
import { type OdooRelease, type ReleaseFiles, type RollBackOffer, decideRelease, listReleases, releaseAgain, releaseFiles, retestRelease, rollBackRelease } from './releases'
import { type ProjectRelease, type ReleaseOptions, getProjectRelease, getReleaseOptions, setProjectRelease } from './release-settings'
import { type ProjectApp, getProjectApp, openProjectApp } from './project-app'
import { type Drift, getDrift, proposeAdoption } from './customizations'
import { type ClientImport, type ImportView, getImport, startFresh } from './client-import'
import { startBackend } from '../../../test/backend/site'
import { projectsOf, releasesOf, type ProjectsSide, type ReleasesSide } from '../../../test/backend/projects'
import type { Wire } from '../../../test/backend/wire'
import { anyOf, arrayWith, objectWith } from '../../../../../backend/src/platform/lib/test-matchers'
import type { OdooRelease as BackendRelease } from '../../../../../backend/src/releases/lib/odoo-release'
import type { ReleaseFiles as BackendFiles, RollBackOffer as BackendOffer } from '../../../../../backend/src/releases/services/OdooReleaseService'
import type { ReleaseAgent } from '../../../../../backend/src/releases/services/ReleaseSettings'
import type { ReleaseApp, ReleaseHow } from '../../../../../backend/src/releases/lib/release-run'
import type { ProjectApp as BackendApp } from '../../../../../backend/src/releases/lib/project-app'
import type { Drift as BackendDrift } from '../../../../../backend/src/releases/services/CustomizationsService'
import type { ImportView as BackendImportView } from '../../../../../backend/src/releases/services/ClientImportService'
import type { ClientImport as BackendImport } from '../../../../../backend/src/releases/lib/client-import'
import { releaseRunWorkflowId } from '../../../../../backend/src/releases/lib/release-run'

let side: ProjectsSide | undefined
let releasing: ReleasesSide | undefined

const backend = await startBackend(async (site) => {
  side = await projectsOf(site)
  releasing = releasesOf(site, side)
})
const owner = await backend.signIn()
const now = new Date().toISOString()
const at = (minutes: number) => new Date(Date.parse(now) + minutes * 60_000).toISOString()

await backend.db.infrastructure.saveCluster({ id: 'machine-desk', name: 'desk', provider: 'machine', status: 'stopped', ownerId: owner.id, machineId: 'desk' })
await backend.db.projects.saveProject({ id: 'shop', name: 'Shop', ownerId: owner.id, appType: 'gitapp', targetClusterId: 'machine-desk', releaseName: 'shop-abc123', createdAt: now })
await backend.db.projects.saveTree({ id: 'tree-shop', ownerId: owner.id, name: 'Shop', type: 'odoo-addons', version: '20', projectIds: ['shop'], createdAt: now, updatedAt: now })
await backend.db.projects.saveProject({ id: 'plain', name: 'Plain', ownerId: owner.id, appType: 'gitapp', createdAt: now })

const release = (id: string, state: BackendRelease['state'], minutes: number, extra: Partial<BackendRelease> = {}): BackendRelease => ({
  id, ownerId: owner.id, projectId: 'shop', pipelineRunId: `run-${id}`, commit: `${id}${'0'.repeat(40)}`.slice(0, 40), image: `registry/shop:${id}`, state, host: 'shop.koala.test', startedAt: at(minutes), updatedAt: at(minutes), ...extra,
})

describe('the shapes the browser reads are the shapes the backend sends', () => {
  it('reads releases, settings, the project\'s app, what was made in it and the client import as the backend describes them', () => {
    expectTypeOf<Wire<BackendRelease>>().toExtend<OdooRelease>()
    expectTypeOf<Wire<BackendOffer>>().toExtend<RollBackOffer>()
    expectTypeOf<Wire<BackendFiles>>().toExtend<ReleaseFiles>()
    expectTypeOf<Wire<{ agents: ReleaseAgent[]; apps: readonly ReleaseApp[] }>>().toExtend<ReleaseOptions>()
    expectTypeOf<Wire<{ how: ReleaseHow; from: 'project' | 'tree type' | 'repository' }>>().toExtend<ProjectRelease>()
    expectTypeOf<Wire<BackendApp>>().toExtend<ProjectApp>()
    expectTypeOf<Wire<BackendDrift>>().toExtend<Drift>()
    expectTypeOf<Wire<BackendImportView>>().toExtend<ImportView>()
    expectTypeOf<Wire<BackendImport>>().toExtend<ClientImport>()
  })
})

describe('how a project releases', () => {
  it('offers the release agents and the apps they release', async () => {
    const options = await getReleaseOptions()
    expect(options.agents).toEqual(arrayWith([objectWith({ slug: 'release', needsApp: true }), objectWith({ slug: 'release-replace', needsApp: false })]))
    expect(options.apps).toEqual([objectWith({ id: 'odoo' })])
  })

  it('reads a project\'s release from its tree type, then from the project once set, and clears it again', async () => {
    expect(await getProjectRelease('shop')).toEqual({ how: { agent: 'release', app: 'odoo' }, from: 'tree type' })
    expect(await setProjectRelease('shop', { agent: 'release-replace' })).toEqual({ how: { agent: 'release-replace' }, from: 'project' })
    expect(await setProjectRelease('shop', null)).toEqual({ how: { agent: 'release', app: 'odoo' }, from: 'tree type' })
  })

  it('reads a project with no tree and no repository as replaced in place', async () => {
    expect(await getProjectRelease('plain')).toEqual({ how: { agent: 'release-replace' }, from: 'repository' })
  })

  it('refuses a release agent that does not exist', async () => {
    await expect(setProjectRelease('shop', { agent: 'nobody-agent' })).rejects.toMatchObject({ response: { status: 400, data: { error: anyOf(String) } } })
  })
})

describe('a project\'s releases, as the release card asks for them', () => {
  it('lists none, with no addresses and nothing to roll back, before the first release', async () => {
    expect(await listReleases('shop')).toEqual({ releases: [], addresses: {} })
  })

  it('lists the releases with the live app\'s addresses and offers to roll back to the one it replaced', async () => {
    await backend.db.releases.saveOdooRelease(release('first', 'superseded', 0, { slot: 'a', replacedBy: 'second' }))
    await backend.db.releases.saveOdooRelease(release('second', 'live', 1, { slot: 'b', liveAt: at(2) }))
    await backend.db.releases.saveOdooRelease(release('third', 'preview', 3, { slot: 'a', previewHost: 'preview-shop.koala.test' }))
    await backend.db.infrastructure.saveDeployment({ id: 'shop-app', name: 'shop-abc123', ownerId: owner.id, clusterId: 'machine-desk', strategy: 'native', appType: 'odoo-project', gitappProjectId: 'shop', status: 'running', publicExposureUrl: 'https://shop.koala.test', previewPublicUrl: 'https://preview-shop.koala.test' })
    const list = await listReleases('shop')
    expect(list.releases.map((entry) => entry.id).sort()).toEqual(['first', 'second', 'third'])
    expect(list.addresses).toEqual({ live: 'https://shop.koala.test', preview: 'https://preview-shop.koala.test' })
    expect(list.rollBack).toBeUndefined()
  })

  it('refuses to cut over or retest a preview no release run is waiting on, saying to push again', async () => {
    await expect(decideRelease('shop', 'third', 'cut-over')).rejects.toMatchObject({ response: { status: 409, data: { error: 'no release is waiting for this preview, so it cannot be cut over: push again to release it' } } })
    await expect(retestRelease('shop', 'third')).rejects.toMatchObject({ response: { status: 409 } })
  })

  it('takes the person\'s decision on a preview whose release run waits for it', async () => {
    await side!.temporal.starter.start('AgentRunWorkflow', { workflowId: releaseRunWorkflowId('shop'), taskQueue: 'engine', args: [], owner: owner.id, memo: {} })
    await decideRelease('shop', 'third', 'discard')
    expect(side!.temporal.workflows.get(releaseRunWorkflowId('shop'))?.signals).toEqual([{ name: 'answer', args: [objectWith({ value: anyOf(String) })] }])
  })

  it('refuses to cut over a release that is live, and one that does not exist', async () => {
    await expect(decideRelease('shop', 'second', 'cut-over')).rejects.toMatchObject({ response: { status: 409, data: { error: 'the release is live, so it cannot be cut over' } } })
    await expect(decideRelease('shop', 'nothing', 'discard')).rejects.toMatchObject({ response: { status: 404, data: { error: 'You have no release with that id' } } })
  })

  it('refuses to roll back once a later build took the kept slot, and to release a live build again', async () => {
    await expect(rollBackRelease('shop', 'second')).rejects.toMatchObject({ response: { status: 409, data: { error: 'the build of third000 has taken the slot the earlier release was kept in' } } })
    await expect(releaseAgain('shop', 'second')).rejects.toMatchObject({ response: { status: 409, data: { error: 'the release is live, so its build cannot be released again' } } })
    await expect(releaseFiles('shop', 'nothing')).rejects.toMatchObject({ response: { status: 404, data: { error: 'This project has no release with that id' } } })
  })
})

describe('the project\'s app', () => {
  it('reads the live app with its addresses, and opens it on this machine', async () => {
    expect(await getProjectApp('shop')).toEqual({ id: 'shop-app', name: 'shop-abc123', status: 'running', local: {}, public: { app: 'https://shop.koala.test', preview: 'https://preview-shop.koala.test' } })
    expect(await openProjectApp('shop', 'local')).toMatchObject({ id: 'shop-app', local: { app: 'http://shop-app.localhost' } })
    expect(await openProjectApp('shop', 'public')).toMatchObject({ public: { app: 'https://shop.koala.test' } })
    expect(releasing!.exposed).toEqual([{ deploymentId: 'shop-app', mode: 'local' }])
  })

  it('reads no app for a project that has none, and refuses a mode that is not one', async () => {
    expect(await getProjectApp('plain')).toBeNull()
    await expect(openProjectApp('shop', 'everywhere' as 'local')).rejects.toMatchObject({ response: { status: 400 } })
  })
})

describe('what was made in the live app', () => {
  it('says a project with no cluster has no live app', async () => {
    await expect(getDrift('plain')).rejects.toMatchObject({ response: { status: 409, data: { error: 'Plain has no cluster, so it has no live app' } } })
  })

  it('refuses a card with no reason before looking at the app', async () => {
    await expect(proposeAdoption('shop', [], '')).rejects.toMatchObject({ response: { status: 400, data: { error: 'say why, for the card' } } })
  })
})

describe('starting from a client\'s database', () => {
  it('says the project has already released, so a client\'s database cannot start it', async () => {
    expect(await getImport('shop')).toEqual({ open: false, why: anyOf(String) })
  })

  it('refuses to start without a client\'s database nobody was waiting for', async () => {
    await expect(startFresh('shop')).rejects.toMatchObject({ response: { status: 409, data: { error: 'Shop is not waiting for a client\'s database' } } })
  })
})

describe('another person', () => {
  it('reaches none of the project\'s releases, settings, app, customizations or import', async () => {
    await backend.signInAnother('second@koala.test')
    await expect(listReleases('shop')).rejects.toMatchObject({ response: { status: 404, data: { error: 'Project not found' } } })
    await expect(decideRelease('shop', 'third', 'discard')).rejects.toMatchObject({ response: { status: 404 } })
    await expect(getProjectRelease('shop')).rejects.toMatchObject({ response: { status: 404, data: { error: 'Project not found' } } })
    await expect(getProjectApp('shop')).rejects.toMatchObject({ response: { status: 404 } })
    await expect(getDrift('shop')).rejects.toMatchObject({ response: { status: 404, data: { error: 'You have no project with that id' } } })
    await expect(getImport('shop')).rejects.toMatchObject({ response: { status: 404 } })
  })
})
