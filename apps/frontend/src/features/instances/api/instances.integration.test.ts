import { testIdentityKey } from '../../../../../backend/src/platform/testing/keys'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  type MySetup, type NameCheck, type PoolAdmin, type PoolOffer, checkName, getMySetup, getPoolAdmin, getPoolOffer,
  removePoolInstance, setPoolTrialDays, setPoolTrialEnd, startMyMove, startPoolInstance, stopMyMove,
} from './instances'
import { getMyInstance } from './identity'
import { type WatchView as BrowserDependencies, getDependencies } from './dependencies'
import { type MailReputationView, getMailReputation } from './mail-reputation'
import { useSetMyWatch } from './instance-watch'
import { startBackend } from '../../../test/backend/site'
import { mutated } from '../../../test/backend/hooks'
import { outsideThisTier } from '../../../test/backend/outside'
import type { Wire } from '../../../test/backend/wire'
import { anyOf, containing, objectWith } from '../../../../../backend/src/platform/lib/test-matchers'
import { identityRouter } from '../../../../../backend/src/instances/routes/identity'
import { instancesRouter } from '../../../../../backend/src/instances/routes/instances'
import { IdentityService } from '../../../../../backend/src/instances/services/IdentityService'
import { InstanceService, instanceIdFor, type PoolOffer as BackendPoolOffer } from '../../../../../backend/src/instances/services/InstanceService'
import { machineCommand, newMachineCode } from '../../../../../backend/src/machines/lib/machines'
import { DependencyWatch, type WatchView as BackendDependencies } from '../../../../../backend/src/instances/services/DependencyWatch'
import { MailReputation, type MailReputationView as BackendMailView } from '../../../../../backend/src/platform/services/MailReputation'
import { roleFromEnv } from '../../../../../backend/src/platform/lib/platform-role'
import type { HeadscaleService } from '../../../../../backend/src/infrastructure/services/HeadscaleService'
import { DEPENDENCY_SOURCES } from '../../../../../backend/src/platform/lib/osv'

const DOMAIN = 'people.koala.test'
const poolWork: string[] = []

const backend = await startBackend(({ api, db, auth, origin }) => {
  const role = roleFromEnv({ ROLE: 'root', ROOT_IDENTITY_KEY: testIdentityKey() })
  const identity = new IdentityService(role, db)
  const instances = new InstanceService(db, {
    rootUrl: origin,
    rootPublicKeys: () => identity.publicKeys().map((key) => key.publicKey),
    registry: '',
    imageTag: 'dev',
    domain: DOMAIN,
    pool: { slots: 1, trialDays: 30 },
    moves: {
      joinCode: async () => ({ command: machineCommand(origin, newMachineCode()), expiresAt: new Date(Date.now() + 3_600_000).toISOString() }),
      poolClusterId: (name) => `pool-${name}`,
    },
  }, outsideThisTier<HeadscaleService>('Headscale'), () => new Date(), () => undefined, {
    start: async (instanceId) => { poolWork.push(`start ${instanceId}`) },
    trialChanged: async (instanceId) => { poolWork.push(`trial ${instanceId}`) },
    remove: async (instanceId) => { poolWork.push(`remove ${instanceId}`) },
    move: async (instanceId) => { poolWork.push(`move ${instanceId}`) },
    moveStopped: async (instanceId) => { poolWork.push(`stop moving ${instanceId}`) },
  })
  api.use('/identity', identityRouter({
    servesTenants: true,
    accounts: { identity, signedIn: (req) => auth.userFromSessionCookie(req.headers.cookie, auth.securedFor(req)), reachOf: async (instanceId) => (await db.instances.getWatch(instanceId))?.reach },
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
expectTypeOf<Wire<BackendPoolOffer>>().toExtend<PoolOffer>()
expectTypeOf<Wire<Extract<Awaited<ReturnType<InstanceService['poolAdmin']>>, { ok: true }>['value']>>().toExtend<PoolAdmin>()
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
    expect(await mutated(useSetMyWatch, false)).toEqual({ notifyWhenUnreachable: false, alwaysTold: false })
    await expect(mutated(useSetMyWatch, 'off' as unknown as boolean)).rejects.toMatchObject({ response: { status: 400, data: { error: 'send notifyWhenUnreachable as true or false' } } })
  })

  it('offers a trial on Koala\'s servers and starts one under the name asked', async () => {
    expect(await getPoolOffer()).toEqual({ available: true, trialDays: 30 })
    const started = await startPoolInstance('kangaroo')
    expect(started).toEqual({ id: anyOf(String), name: 'kangaroo', trialEndsAt: anyOf(String) })
    expect(poolWork).toEqual([`start ${started.id}`])
    expect(await getMySetup()).toEqual(objectWith({ id: started.id, status: 'installing', name: 'kangaroo', trialEndsAt: started.trialEndsAt, watch: { notifyWhenUnreachable: false, alwaysTold: true } }))
    await expect(startPoolInstance('wombat')).rejects.toMatchObject({ response: { status: 400, data: { error: 'your instance on Koala\'s servers is already there' } } })
  })

  it('starts and stops moving the trial to their own machine', async () => {
    await expect(startMyMove()).rejects.toMatchObject({ response: { status: 409, data: { error: anyOf(String) } } })
    const [instance] = await backend.db.instances.getInstances()
    await backend.db.instances.saveInstance({ ...instance!, status: 'ready', url: `https://kangaroo.${DOMAIN}` })
    const move = await startMyMove()
    expect(move).toEqual(objectWith({ command: containing(`curl -fsSL ${backend.origin}/machine.sh | sh -s -- `), expiresAt: anyOf(String) }))
    expect(poolWork).toContain(`move ${instance!.id}`)
    expect((await getMySetup())?.move).toEqual({ state: 'waiting', startedAt: anyOf(String), detail: 'Waiting for your machine to run the move command' })
    expect(await stopMyMove()).toEqual({ stopping: true })
    expect(poolWork).toContain(`stop moving ${instance!.id}`)
  })
})

describe('the pool an operator runs, where accounts are held', () => {
  it('lists the pool with its trials and changes the default trial length', async () => {
    const admin = await getPoolAdmin()
    expect(admin).toEqual(objectWith({ slots: 1, trialDays: 30, defaultTrialDays: 30, instances: [objectWith({ name: 'kangaroo', owner: 'owner@koala.test', status: 'ready' })] }))
    expect(await setPoolTrialDays(14)).toEqual(objectWith({ trialDays: 14 }))
    await expect(setPoolTrialDays(0)).rejects.toMatchObject({ response: { status: 400, data: { error: anyOf(String) } } })
  })

  it('moves a trial\'s end, refusing a date in the past and an instance that is not in the pool', async () => {
    const [row] = (await getPoolAdmin()).instances
    const later = new Date(Date.now() + 60 * 86_400_000).toISOString()
    expect(await setPoolTrialEnd(row!.id, later)).toEqual(objectWith({ id: row!.id, name: 'kangaroo', trialEndsAt: later }))
    expect(poolWork).toContain(`trial ${row!.id}`)
    await expect(setPoolTrialEnd(row!.id, '2001-01-01T00:00:00.000Z')).rejects.toMatchObject({ response: { status: 400, data: { error: 'the new end of the trial has to be in the future' } } })
    await expect(setPoolTrialEnd('nobody', later)).rejects.toMatchObject({ response: { status: 404, data: { error: 'no pool instance by that id' } } })
  })

  it('deletes a trial only once its name is typed', async () => {
    const [row] = (await getPoolAdmin()).instances
    await expect(removePoolInstance(row!.id, 'wrong')).rejects.toMatchObject({ response: { status: 400, data: { error: containing('"kangaroo"') } } })
    expect(await removePoolInstance(row!.id, 'kangaroo')).toEqual({ removing: 'kangaroo' })
    expect(poolWork).toContain(`remove ${row!.id}`)
  })

  it('reads the dependencies record, empty before a check, and root\'s mail before it is checked', async () => {
    expect(await getDependencies()).toEqual({ findings: [] })
    expect(await getMailReputation()).toEqual({ checking: false })
  })
})

describe('what someone who is not an operator sees of the pool, where accounts are held', () => {
  it('is told the pool is full and refused its administration, its dependencies and its mail', async () => {
    await backend.signInAnother('second@koala.test')
    expect(await getPoolOffer()).toEqual({ available: false, reason: 'Koala\'s servers are full right now; use your own machine, or try again later', trialDays: 14 })
    await expect(startPoolInstance('wombat')).rejects.toMatchObject({ response: { status: 503 } })
    await expect(getPoolAdmin()).rejects.toMatchObject({ response: { status: 403 } })
    await expect(getDependencies()).rejects.toMatchObject({ response: { status: 403 } })
    await expect(getMailReputation()).rejects.toMatchObject({ response: { status: 403 } })
    await expect(stopMyMove()).rejects.toMatchObject({ response: { status: 404, data: { error: 'nothing is moving' } } })
    await expect(mutated(useSetMyWatch, true)).rejects.toMatchObject({ response: { status: 404, data: { error: 'you have no instance' } } })
  })
})
