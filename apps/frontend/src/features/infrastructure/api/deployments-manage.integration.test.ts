import { describe, expect, expectTypeOf, it } from 'vitest'
import { type AppSignIn, destroyResource, exposeDeployment, getAppSignIn, patchDeploymentConfig, setDeploymentModules, setExposurePath, unexposeDeployment } from './deployments'
import { startBackend } from '../../../test/backend/site'
import { infrastructureOf, type Infrastructure } from '../../../test/backend/infrastructure'
import { outsideThisTier } from '../../../test/backend/outside'
import type { Wire } from '../../../test/backend/wire'
import { deploymentsRouter } from '../../../../../backend/src/infrastructure/routes/deployments'
import type { AppExposureService } from '../../../../../backend/src/infrastructure/services/AppExposureService'
import type { AppSignIn as BackendAppSignIn } from '../../../../../backend/src/infrastructure/lib/app-sign-in'
import type { DeploymentMetadata } from '../../../../../backend/src/platform/lib/types'
import { objectWith } from '../../../../../backend/src/platform/lib/test-matchers'

let infra: Infrastructure | undefined

const backend = await startBackend(async (site) => {
  infra = await infrastructureOf(site)
  site.api.use('/deployments', deploymentsRouter({
    appService: infra.apps,
    clusterService: infra.clusters,
    appExposureService: outsideThisTier<AppExposureService>('app exposure, which writes the edge\'s routes'),
    access: infra.clusters.access,
    temporalBridge: infra.bridge,
    db: site.db,
    io: infra.io,
  }))
})

const owner = await backend.signIn()
await backend.db.infrastructure.saveCluster({ id: 'machine-desk', name: 'desk', provider: 'machine', status: 'stopped', ownerId: owner.id, machineId: 'desk' })
const app = (id: string, over: Partial<DeploymentMetadata>): DeploymentMetadata => ({ id, name: id, namespace: `${id}-abcdef`, clusterId: 'machine-desk', strategy: 'native', status: 'running', modules: [], storage: {}, ownerId: owner.id, ...over } as DeploymentMetadata)
await backend.db.infrastructure.saveDeployment(app('hermes', { appType: 'hermes', hermesDashboardPassword: 'a-made-password' }))
await backend.db.infrastructure.saveDeployment(app('qwen', { appType: 'tabbyapi', tabbyModel: 'turboderp/Qwen3-exl3', tabbyGpuCount: 1 }))
await backend.db.infrastructure.saveDeployment(app('pals', { appType: 'palworld' }))
await backend.db.infrastructure.saveDeployment(app('theirs', { appType: 'hermes', ownerId: 'someone-else' }))

expectTypeOf<Wire<BackendAppSignIn>>().toExtend<AppSignIn>()

describe('an app\'s page, as it asks the backend', () => {
  it('shows the sign-in Koala made for the app to its owner only', async () => {
    expect(await getAppSignIn('hermes')).toEqual([{ describe: 'The Hermes dashboard', login: 'admin', password: 'a-made-password' }])
    expect(await getAppSignIn('qwen')).toEqual([])
    await expect(getAppSignIn('theirs')).rejects.toMatchObject({ response: { status: 404, data: { error: 'Deployment not found' } } })
  })

  it('saves the TabbyAPI settings the page sends and starts re-applying the app', async () => {
    await patchDeploymentConfig('qwen', { storage: { models: '200Gi' }, tabbyModel: 'turboderp/Qwen3-exl3', tabbyRevision: '4.0bpw', tabbyGpuCount: 2, tabbyImageTag: 'latest', tabbyCacheMode: 'Q8', tabbyMaxSeqLen: 65536, tabbyReasoning: true, tabbyToolFormat: 'qwen3_coder', tabbyInlineModelLoading: false, tabbyDisableAuth: true, tabbyMemoryLimit: '', tabbyShmSize: '', tabbyCpuLimit: '10', tabbyExtraEnv: '' })
    expect(infra!.temporal.started.at(-1)?.options.args?.[0]).toMatchObject({ name: 'qwen', appType: 'tabbyapi', tabbyRevision: '4.0bpw', tabbyGpuCount: 2, tabbyMaxSeqLen: 65536, storage: objectWith({ models: '200Gi' }) })
  })

  it('refuses settings of the wrong kind, saying which', async () => {
    await expect(patchDeploymentConfig('qwen', { tabbyGpuCount: 'two' })).rejects.toMatchObject({ response: { status: 400, data: { error: 'tabbyGpuCount must be a number' } } })
    await expect(patchDeploymentConfig('qwen', { appSettings: { PLAYERS: '8' } })).rejects.toMatchObject({ response: { status: 400, data: { error: 'App type "tabbyapi" has no settings schema' } } })
  })

  it('refuses a game server\'s settings it cannot take, listing what was wrong', async () => {
    await expect(patchDeploymentConfig('pals', { appSettings: { PLAYERS: 'lots' } })).rejects.toMatchObject({ response: { status: 400, data: { error: 'Invalid settings' } } })
  })

  it('refuses to expose a game server, which has no web page', async () => {
    await expect(exposeDeployment('pals', 'public')).rejects.toMatchObject({ response: { status: 400 } })
  })

  it('refuses to change modules that are not a list of names', async () => {
    await expect(setDeploymentModules('qwen', [1 as unknown as string])).rejects.toMatchObject({ response: { status: 400, data: { error: 'modules must be a list of module names' } } })
  })

  it('starts destroying an app that runs and answers 202', async () => {
    await destroyResource('hermes')
    expect(infra!.temporal.started.at(-1)?.options.args?.[0]).toMatchObject({ name: 'hermes' })
    expect((await backend.db.infrastructure.getDeployments()).find((dep) => dep.id === 'hermes')?.status).toBe('destroying')
  })

  it('answers 404 for every change to someone else\'s app', async () => {
    const missing = { response: { status: 404, data: { error: 'Deployment not found' } } }
    await expect(destroyResource('theirs')).rejects.toMatchObject(missing)
    await expect(exposeDeployment('theirs', 'local')).rejects.toMatchObject(missing)
    await expect(unexposeDeployment('theirs', 'public')).rejects.toMatchObject(missing)
    await expect(setExposurePath('theirs', '/')).rejects.toMatchObject(missing)
    await expect(patchDeploymentConfig('theirs', {})).rejects.toMatchObject(missing)
  })
})
