import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import { afterAll, describe, expect, expectTypeOf, it } from 'vitest'
import { type UpdatesView, changeInstanceUpdates, getInstanceUpdates, getReleaseFindings } from './instance-updates'
import { type InstanceAddressesView, getInstanceAddresses, setNestedAddresses } from './instance-addresses'
import { type WatchView, useInstanceWatch, useSetInstanceWatch } from './instance-watch'
import { getInstanceMove, getInstanceTrial, startInstanceMove, stopInstanceMove } from './instances'
import { accountRemovalPlace } from '../../platform'
import { startBackend } from '../../../test/backend/site'
import { mutated, queried } from '../../../test/backend/hooks'
import { outsideThisTier } from '../../../test/backend/outside'
import type { Wire } from '../../../test/backend/wire'
import { anyOf, arrayWith, containing, objectWith } from '../../../../../backend/src/platform/lib/test-matchers'
import { testDatabase } from '../../../../../backend/src/platform/lib/test-database'
import { createAuth } from '../../../../../backend/src/platform/middleware/auth'
import { errorResponder } from '../../../../../backend/src/platform/middleware/async-route'
import { SessionEnds } from '../../../../../backend/src/platform/services/SessionEnds'
import { instancesRouter } from '../../../../../backend/src/instances/routes/instances'
import { instanceUpdatesRouter } from '../../../../../backend/src/instances/routes/instance-updates'
import { instanceAddressesRouter } from '../../../../../backend/src/instances/routes/instance-addresses'
import { instanceWatchRouter } from '../../../../../backend/src/instances/routes/instance-watch'
import { instanceTrialRouter } from '../../../../../backend/src/instances/routes/instance-trial'
import { signInRouter } from '../../../../../backend/src/instances/routes/sign-in'
import { InstanceService, hashCredential, type WatchView as BackendWatchView } from '../../../../../backend/src/instances/services/InstanceService'
import { InstanceUpdates, type UpdatesAnswer } from '../../../../../backend/src/instances/services/InstanceUpdates'
import { InstanceAddresses, type AddressesView } from '../../../../../backend/src/instances/services/InstanceAddresses'
import { InstanceWatchSetting } from '../../../../../backend/src/instances/services/InstanceWatchSetting'
import { InstanceTrial } from '../../../../../backend/src/instances/services/InstanceTrial'
import { IdentityService } from '../../../../../backend/src/instances/services/IdentityService'
import { ReleaseCatalogue } from '../../../../../backend/src/instances/services/ReleaseCatalogue'
import type { RootSignIn } from '../../../../../backend/src/instances/services/RootSignIn'
import type { HeadscaleService } from '../../../../../backend/src/infrastructure/services/HeadscaleService'
import { principalOf } from '../../../../../backend/src/platform/lib/permissions'
import type { UserMetadata } from '../../../../../backend/src/platform/lib/types'
import type { RoleConfig } from '../../../../../backend/src/platform/lib/platform-role'

const INSTANCE_ID = 'inst-kangaroo'
const CREDENTIAL = 'the-instance-credential'
const DOMAIN = 'people.koala.test'
const OLDER = 'imgolder'
const NEWER = 'imgnewer'
const moves: string[] = []

const rootDb = await testDatabase()
const charts = await mkdtemp(join(tmpdir(), 'koala-root-charts-'))
for (const tag of [OLDER, NEWER]) await writeFile(join(charts, `${tag}.tgz`), '')
await rootDb.instances.recordRelease({ imageTag: OLDER, version: 'v2026.10.01', servedAt: '2026-10-01T00:00:00.000Z' })
await rootDb.instances.recordRelease({ imageTag: NEWER, version: 'v2026.11.01', servedAt: '2026-11-01T00:00:00.000Z' })
const root = express()
const rootServer = http.createServer(root)
await new Promise<void>((resolve) => rootServer.listen(0, '127.0.0.1', () => resolve()))
afterAll(() => new Promise<void>((resolve) => rootServer.close(() => resolve())))
const rootUrl = `http://127.0.0.1:${(rootServer.address() as AddressInfo).port}`
const rootAuth = createAuth({ db: rootDb, sessionKey: 'root-session-key', publicUrl: rootUrl, role: 'root', sessionEnds: new SessionEnds(rootDb.platform) })
root.use('/api', rootAuth.requireAuth)
root.use(express.json())
root.use('/api/instances', instancesRouter({
  instances: new InstanceService(rootDb, {
    rootUrl,
    rootPublicKeys: () => [],
    registry: '',
    imageTag: NEWER,
    domain: DOMAIN,
    pool: { slots: 2, trialDays: 30 },
    releases: new ReleaseCatalogue(rootDb.instances, {
      repoRoot: charts,
      chartsDir: charts,
      imageTag: NEWER,
      chart: async () => { throw new Error('the instance chart is packed by helm on the host, outside this tier') },
      inventory: async () => { throw new Error('a release inventory is made by git on the host, outside this tier') },
    }),
  }, outsideThisTier<HeadscaleService>('Headscale'), () => new Date(), () => undefined, {
    start: async () => undefined,
    trialChanged: async () => undefined,
    remove: async () => undefined,
    move: async (instanceId) => { moves.push(`move ${instanceId}`) },
    moveStopped: async (instanceId, reason) => { moves.push(`stop ${instanceId}: ${reason}`) },
  }),
  chart: async () => { throw new Error('the instance chart is packed by helm on the host, outside this tier') },
}))
root.use(errorResponder)

const token = async (): Promise<string> => CREDENTIAL

const theInstance: { ownerId?: string } = {}

const backend = await startBackend(({ api, db }) => {
  api.use((req, _res, next) => {
    const person = (req as unknown as { user?: UserMetadata }).user
    if (person && theInstance.ownerId) Object.assign(req, { principal: principalOf(person, { role: 'instance', instanceOwnerId: theInstance.ownerId }) })
    next()
  })
  const instanceRole = { role: 'instance', instance: { id: INSTANCE_ID, ownerId: 'owner', rootUrl } } as RoleConfig
  const addresses = new InstanceAddresses({ rootUrl, instanceId: INSTANCE_ID, token, name: 'kangaroo' }, async () => undefined)
  api.use('/instance-addresses', instanceAddressesRouter({ addresses: () => addresses }))
  api.use('/instance-watch', instanceWatchRouter({ setting: new InstanceWatchSetting({ rootUrl, instanceId: INSTANCE_ID, token }) }))
  api.use('/instance-trial', instanceTrialRouter({ trial: new InstanceTrial({ rootUrl, instanceId: INSTANCE_ID, token }) }))
  api.use('/instance-updates', instanceUpdatesRouter({
    updates: new InstanceUpdates({ rootUrl, instanceId: INSTANCE_ID, token }, async () => { throw new Error('kubectl reaches the instance\'s own cluster, outside this tier') }),
  }))
  api.use('/auth', signInRouter({
    signIn: outsideThisTier<RootSignIn>('root\'s OpenID provider'),
    identity: new IdentityService(instanceRole, db),
    auth: outsideThisTier('the instance\'s session cookies'),
    publicUrl: 'https://kangaroo.people.koala.test',
    landing: '/chat',
  }))
})

const owner = await backend.signIn()
theInstance.ownerId = owner.id
const trialEndsAt = new Date(Date.now() + 20 * 86_400_000).toISOString()
await rootDb.instances.saveInstance({
  id: INSTANCE_ID, ownerId: owner.id, url: `https://kangaroo.${DOMAIN}`, name: 'kangaroo', status: 'ready', running: NEWER, previous: OLDER,
  credentialHash: hashCredential(CREDENTIAL), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  pool: { ports: { backend: 31000, edge: 31001, registry: 31002 }, startedAt: new Date().toISOString(), trialEndsAt },
})

expectTypeOf<Wire<UpdatesAnswer>>().toExtend<UpdatesView>()
expectTypeOf<Wire<AddressesView>>().toExtend<InstanceAddressesView>()
expectTypeOf<Wire<BackendWatchView>>().toExtend<WatchView>()

describe('an instance\'s settings, as an instance asks root for them with its credential', () => {
  it('reads its updates: automatic, running the newer release, with both releases listed', async () => {
    const view = await getInstanceUpdates()
    expect(view).toEqual(objectWith({ auto: true, running: NEWER, previous: OLDER, current: NEWER, target: NEWER }))
    expect(view?.releases.map((release) => [release.imageTag, release.running])).toEqual(arrayWith([[NEWER, true], [OLDER, false]]))
  })

  it('turns automatic updates off and on again, staying on the release it runs', async () => {
    expect(await changeInstanceUpdates({ auto: false })).toEqual(objectWith({ auto: false, target: NEWER }))
    expect(await changeInstanceUpdates({ auto: true })).toEqual(objectWith({ auto: true, target: NEWER }))
  })

  it('refuses a release root does not know, in root\'s words', async () => {
    await expect(changeInstanceUpdates({ version: 'v1999.01.01' })).rejects.toMatchObject({ response: { status: 409, data: { error: anyOf(String) } } })
  })

  it('reads what the release it runs is found to carry, nothing before root checked', async () => {
    expect(await getReleaseFindings()).toEqual({ findings: [] })
  })

  it('reads its addresses under the people\'s domain, flat until asked otherwise', async () => {
    expect(await getInstanceAddresses()).toEqual({ nested: false, name: 'kangaroo', domain: DOMAIN })
    expect(await setNestedAddresses(false)).toEqual({ nested: false, name: 'kangaroo', domain: DOMAIN })
  })

  it('reads its trial\'s end and the days left', async () => {
    expect(await getInstanceTrial()).toEqual({ trialEndsAt, daysLeft: 20 })
  })

  it('reads whether root tells the owner when it is down, always for a trial, and refuses switching that off', async () => {
    const watch = await queried(useInstanceWatch)
    expect(watch.error).toBeNull()
    expect(watch.data).toEqual({ notifyWhenUnreachable: true, alwaysTold: true })
    await expect(mutated(useSetInstanceWatch, false)).rejects.toMatchObject({ response: { status: 409, data: { error: 'an instance on Koala\'s servers always tells its owner when it cannot be reached' } } })
  })

  it('starts its move to the owner\'s machine, reads it under way and stops it', async () => {
    expect(await getInstanceMove()).toBeNull()
    const started = await startInstanceMove()
    expect(started).toEqual({ command: containing(`curl -fsSL ${rootUrl}/install.sh | sudo sh -s -- `), expiresAt: anyOf(String) })
    expect(await getInstanceMove()).toEqual({ state: 'waiting', startedAt: anyOf(String), detail: 'Waiting for your machine to run the move command' })
    expect(await stopInstanceMove()).toEqual({ stopping: true })
    expect(moves).toEqual([`move ${INSTANCE_ID}`, `stop ${INSTANCE_ID}: you stopped the move`])
  })

  it('refuses someone who is not the instance\'s owner a change to its settings', async () => {
    await backend.signInAnother('second@koala.test')
    await expect(changeInstanceUpdates({ auto: false })).rejects.toMatchObject({ response: { status: 403, data: { error: anyOf(String) } } })
    await expect(setNestedAddresses(true)).rejects.toMatchObject({ response: { status: 403 } })
    await expect(startInstanceMove()).rejects.toMatchObject({ response: { status: 403 } })
    await expect(mutated(useSetInstanceWatch, true)).rejects.toMatchObject({ response: { status: 403 } })
  })

  it('sends the person to root to delete their account', async () => {
    expect(await accountRemovalPlace()).toBe(`${rootUrl}/#/remove-account`)
  })
})
