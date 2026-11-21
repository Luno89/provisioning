import { testIdentityKey } from '../../../../../backend/src/platform/testing/keys'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { type MySetup, type NameCheck, checkName, getMySetup } from './instances'
import { getMyInstance } from './identity'
import { type WatchView as BrowserDependencies, getDependencies } from './dependencies'
import { type MailReputationView, getMailReputation } from './mail-reputation'
import { useSetMyWatch } from './instance-watch'
import { startBackend } from '../../../test/backend/site'
import { mutated } from '../../../test/backend/hooks'
import { outsideThisTier } from '../../../test/backend/outside'
import type { Wire } from '../../../test/backend/wire'
import { anyOf } from '../../../../../backend/src/platform/lib/test-matchers'
import { identityRouter } from '../../../../../backend/src/instances/routes/identity'
import { instancesRouter } from '../../../../../backend/src/instances/routes/instances'
import { IdentityService } from '../../../../../backend/src/instances/services/IdentityService'
import { InstanceService, instanceIdFor } from '../../../../../backend/src/instances/services/InstanceService'
import { DependencyWatch, type WatchView as BackendDependencies } from '../../../../../backend/src/instances/services/DependencyWatch'
import { MailReputation, type MailReputationView as BackendMailView } from '../../../../../backend/src/platform/services/MailReputation'
import { roleFromEnv } from '../../../../../backend/src/platform/lib/platform-role'
import type { HeadscaleService } from '../../../../../backend/src/infrastructure/services/HeadscaleService'
import { DEPENDENCY_SOURCES } from '../../../../../backend/src/platform/lib/osv'
import { testInstanceClients } from '../../../../../backend/src/instances/testing/placed-koala'

const DOMAIN = 'people.koala.test'

const backend = await startBackend(({ api, db, auth, origin }) => {
  const role = roleFromEnv({ ROLE: 'root', ROOT_IDENTITY_KEY: testIdentityKey() })
  const identity = new IdentityService(role, db)
  const instances = new InstanceService(db, {
    rootUrl: origin,
    rootPublicKeys: () => identity.publicKeys().map((key) => key.publicKey),
    ...testInstanceClients,
    registry: '',
    imageTag: 'dev',
    domain: DOMAIN,
  }, outsideThisTier<HeadscaleService>('Headscale'), () => new Date(), () => undefined)
  api.use('/identity', identityRouter({
    servesTenants: true,
    accounts: { identity, signedIn: (req) => auth.userOf(req), reachOf: async (instanceId) => (await db.instances.getWatch(instanceId))?.reach },
  }))
  api.use('/instances', instancesRouter({
    instances,
    chart: async () => { throw new Error('the instance chart is packed by helm on the host, outside this tier') },
    operatorOnly: auth.requireOperator('manage-accounts'),
    administers: auth.requireOperator('administer'),
    dependencies: new DependencyWatch({
      store: db.instances,
      inventoryOf: async () => undefined,
      currentRelease: 'dev',
      fetchImpl: (() => { throw new Error('OSV is on the internet, outside this tier') }) as typeof fetch,
      sources: DEPENDENCY_SOURCES,
      tell: async () => undefined,
      rootUrl: origin,
    }),
    mailReputation: new MailReputation({ domain: 'koala.test' }),
  }))
})

expectTypeOf<Wire<NonNullable<Awaited<ReturnType<InstanceService['mine']>>>>>().toExtend<MySetup>()
expectTypeOf<Wire<Awaited<ReturnType<InstanceService['nameCheck']>>>>().toExtend<NameCheck>()
expectTypeOf<Wire<BackendDependencies>>().toExtend<BrowserDependencies>()
expectTypeOf<Wire<BackendMailView>>().toExtend<MailReputationView>()

describe('a person\'s instance, where accounts are held', () => {
  it('has no instance yet, and says this server also serves people\'s work', async () => {
    await backend.signIn()
    expect(await getMyInstance()).toEqual({ instance: null, servesTenants: true })
    expect(await getMySetup()).toBeNull()
  })

  it('suggests a name from the email, gives the address of a free one and refuses one it cannot take', async () => {
    expect(await checkName('')).toEqual({ ok: false, suggestion: 'owner' })
    expect(await checkName('kangaroo')).toEqual({ ok: true, address: `https://kangaroo.${DOMAIN}` })
    expect(await checkName('Not A Name!')).toEqual({ ok: false, problem: anyOf(String) })
  })

  it('switches off being told when their own machine cannot be reached', async () => {
    const [owner] = await backend.db.accounts.getUsers()
    const now = new Date().toISOString()
    await backend.db.instances.saveInstance({ id: instanceIdFor(owner!.id), ownerId: owner!.id, url: '', createdAt: now, updatedAt: now, status: 'waiting', name: 'kangaroo' })
    expect(await mutated(useSetMyWatch, false)).toEqual({ notifyWhenUnreachable: false })
    await expect(mutated(useSetMyWatch, 'off' as unknown as boolean)).rejects.toMatchObject({ response: { status: 400, data: { error: 'send notifyWhenUnreachable as true or false' } } })
  })
})

describe('what an operator reads, where accounts are held', () => {
  it('reads the dependencies record, empty before a check, and root\'s mail before it is checked', async () => {
    expect(await getDependencies()).toEqual({ findings: [] })
    expect(await getMailReputation()).toEqual({ checking: false })
  })
})

describe('what someone who is not an operator is refused, where accounts are held', () => {
  it('is refused the dependencies and the mail', async () => {
    await backend.signInAnother('second@koala.test')
    await expect(getDependencies()).rejects.toMatchObject({ response: { status: 403 } })
    await expect(getMailReputation()).rejects.toMatchObject({ response: { status: 403 } })
    await expect(mutated(useSetMyWatch, true)).rejects.toMatchObject({ response: { status: 404, data: { error: 'you have no instance' } } })
  })
})
