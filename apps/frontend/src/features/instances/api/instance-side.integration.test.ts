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
import { accountRemovalPlace } from '../../platform'
import { INSTANCE_ID, startBackend } from '../../../test/backend/site'
import { mutated, queried } from '../../../test/backend/hooks'
import { outsideThisTier } from '../../../test/backend/outside'
import type { Wire } from '../../../test/backend/wire'
import { anyOf, arrayWith, objectWith } from '../../../../../backend/src/platform/lib/test-matchers'
import { testDatabase } from '../../../../../backend/src/platform/lib/test-database'
import { createAuth } from '../../../../../backend/src/platform/middleware/auth'
import { errorResponder } from '../../../../../backend/src/platform/middleware/async-route'
import { SessionEnds } from '../../../../../backend/src/platform/services/SessionEnds'
import { instancesRouter } from '../../../../../backend/src/instances/routes/instances'
import { instanceUpdatesRouter } from '../../../../../backend/src/instances/routes/instance-updates'
import { instanceAddressesRouter } from '../../../../../backend/src/instances/routes/instance-addresses'
import { instanceWatchRouter } from '../../../../../backend/src/instances/routes/instance-watch'
import { InstanceService, type WatchView as BackendWatchView } from '../../../../../backend/src/instances/services/InstanceService'
import { InstanceUpdates, type UpdatesAnswer } from '../../../../../backend/src/instances/services/InstanceUpdates'
import { InstanceAddresses, type AddressesView } from '../../../../../backend/src/instances/services/InstanceAddresses'
import { InstanceWatchSetting } from '../../../../../backend/src/instances/services/InstanceWatchSetting'
import { ReleaseCatalogue } from '../../../../../backend/src/instances/services/ReleaseCatalogue'
import type { HeadscaleService } from '../../../../../backend/src/infrastructure/services/HeadscaleService'
import { openRoutesOf } from '../../../../../backend/src/open-routes'
import { testInstanceClients, tokenOfInstance } from '../../../../../backend/src/instances/testing/placed-koala'

const DOMAIN = 'people.koala.test'
const OLDER = 'imgolder'
const NEWER = 'imgnewer'

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
const rootAuth = createAuth({ db: rootDb, sessionKey: 'root-session-key', publicUrl: rootUrl, role: 'root', open: openRoutesOf('root'), sessionEnds: new SessionEnds(rootDb.platform) })
root.use('/api', rootAuth.requireAuth)
root.use(express.json())
root.use('/api/instances', instancesRouter({
  instances: new InstanceService(rootDb, {
    rootUrl,
    rootPublicKeys: () => [],
    ...testInstanceClients,
    registry: '',
    imageTag: NEWER,
    domain: DOMAIN,
    releases: new ReleaseCatalogue(rootDb.instances, {
      dataVersion: async () => 0,
      repoRoot: charts,
      chartsDir: charts,
      imageTag: NEWER,
      chart: async () => { throw new Error('the instance chart is packed by helm on the host, outside this tier') },
      inventory: async () => { throw new Error('a release inventory is made by git on the host, outside this tier') },
    }),
  }, outsideThisTier<HeadscaleService>('Headscale'), () => new Date(), () => undefined),
  chart: async () => { throw new Error('the instance chart is packed by helm on the host, outside this tier') },
}))
root.use(errorResponder)

const token = async (): Promise<string> => tokenOfInstance(INSTANCE_ID)

const backend = await startBackend(({ api }) => {
  const addresses = new InstanceAddresses({ rootUrl, instanceId: INSTANCE_ID, token, name: 'kangaroo' }, async () => undefined)
  api.use('/instance-addresses', instanceAddressesRouter({ addresses: () => addresses }))
  api.use('/instance-watch', instanceWatchRouter({ setting: new InstanceWatchSetting({ rootUrl, instanceId: INSTANCE_ID, token }) }))
  api.use('/instance-updates', instanceUpdatesRouter({
    updates: new InstanceUpdates({ rootUrl, instanceId: INSTANCE_ID, token }, async () => { throw new Error('kubectl reaches the instance\'s own cluster, outside this tier') }),
  }))
}, { role: 'instance', root: { app: root, url: rootUrl, db: rootDb } })

await backend.signIn()
const [placed] = await rootDb.instances.getInstances()
await rootDb.instances.saveInstance({ ...placed!, name: 'kangaroo', running: NEWER, previous: OLDER, updatedAt: new Date().toISOString() })

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

  it('reads whether root tells the owner when it is down, and switches it off for the owner', async () => {
    const watch = await queried(useInstanceWatch)
    expect(watch.error).toBeNull()
    expect(watch.data).toEqual({ notifyWhenUnreachable: true })
    expect(await mutated(useSetInstanceWatch, false)).toEqual({ notifyWhenUnreachable: false })
    expect(await rootDb.instances.getWatch(INSTANCE_ID)).toMatchObject({ notifyWhenUnreachable: false })
  })

  it('turns someone who is not the instance\'s owner away at root, so they change none of its settings', async () => {
    expect(await backend.turnedAway('second@koala.test')).toMatch(/belongs to someone else/)
    await expect(changeInstanceUpdates({ auto: false })).rejects.toMatchObject({ response: { status: 401, data: { error: anyOf(String) } } })
    await expect(setNestedAddresses(true)).rejects.toMatchObject({ response: { status: 401 } })
    await expect(mutated(useSetInstanceWatch, true)).rejects.toMatchObject({ response: { status: 401 } })
  })

  it('sends the person to root to delete their account', async () => {
    expect(await accountRemovalPlace()).toBe(`${rootUrl}/#/remove-account`)
  })
})
