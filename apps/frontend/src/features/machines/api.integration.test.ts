import { describe, expect, expectTypeOf, it } from 'vitest'
import { type AccountMachine, type LocalAgentDevice, type MachineJoinCode, createMachineJoinCode, createMyJoinCode, deleteLocalAgentDevice, dismissMachineJoin, installMachineAdapter, listLocalAgentDevices, listMyMachines, putKoalaOn, setMachineAgents } from './api'
import { startBackend } from '../../test/backend/site'
import { machinesOf, type Machines } from '../../test/backend/machines'
import type { AccountMachine as RootMachine, MachineAccounts } from '../../../../backend/src/machines/services/MachineAccounts'
import { localAgentsRouter } from '../../../../backend/src/machines/routes/local-agents'
import { myMachinesRouter } from '../../../../backend/src/machines/routes/my-machines'
import type { MachineView } from '../../../../backend/src/machines/services/MachineService'
import type { Wire } from '../../test/backend/wire'
import { anyOf, objectWith } from '../../../../backend/src/platform/lib/test-matchers'

let side: Machines | undefined

const backend = await startBackend((site) => {
  side = machinesOf(site)
  site.api.use('/mesh/local-agents', localAgentsRouter({ machines: side.machines }))
  site.api.use('/my-machines', myMachinesRouter({
    accounts: side.accounts,
    koalaOf: async (owner) => {
      const instance = (await site.db.instances.getInstances(owner))[0]
      return instance ? { machineId: instance.machineId, status: instance.status } : undefined
    },
  }))
})

const joined = async (name: string, codeOf: () => Promise<{ code: string }>): Promise<string> => side!.join(name, (await codeOf()).code)

expectTypeOf<Wire<MachineView>>().toExtend<LocalAgentDevice>()
expectTypeOf<Wire<RootMachine & { online: boolean; koalaWanted: boolean; holdsKoala: boolean }>>().toExtend<AccountMachine>()
expectTypeOf<Wire<Awaited<ReturnType<MachineAccounts['createJoinCode']>>>>().toExtend<MachineJoinCode>()

describe('My Machines, as the browser asks for it', () => {
  it('makes a join code whose command runs the installer from this Koala', async () => {
    await backend.signIn()
    const made = await createMachineJoinCode()
    expect(made.command).toBe(`curl -fsSL ${backend.origin}/machine.sh | sh -s -- ${made.code}`)
    expect(Date.parse(made.expiresAt)).toBeGreaterThan(Date.now())
  })

  it('lists a joined machine with the fields the machine cards read', async () => {
    const id = await joined('desk', createMachineJoinCode)
    const listed = await listLocalAgentDevices()
    expect(listed).toEqual([objectWith({ id, name: 'desk', rootDir: '/home/me/desk', online: false, tokenExpired: false, agents: [], manualAgents: [] })])
    expect(typeof listed[0]?.createdAt).toBe('string')
  })

  it('saves an agent added by hand and answers with the machine as it now is', async () => {
    const [device] = await listLocalAgentDevices()
    const saved = await setMachineAgents(device!.id, [{ id: 'my-agent', title: 'Mine', command: 'my-agent', args: ['--acp'] }])
    expect(saved).toMatchObject({ id: device!.id, manualAgents: [{ id: 'my-agent', title: 'Mine', command: 'my-agent', args: ['--acp'] }] })
  })

  it('refuses an agent list that is not one, with the reason the page shows', async () => {
    const [device] = await listLocalAgentDevices()
    await expect(setMachineAgents(device!.id, [{ id: '', command: '', args: [] }])).rejects.toMatchObject({ response: { status: 400, data: { error: anyOf(String) } } })
  })

  it('refuses to install an adapter on a machine that is not connected, saying so', async () => {
    const [device] = await listLocalAgentDevices()
    await side!.agents(device!.id, [{ id: 'claude-code', title: 'Claude Code', state: 'needs-adapter', source: 'found', adapter: 'claude-acp' }])
    await expect(installMachineAdapter(device!.id, 'claude-code')).rejects.toMatchObject({ response: { status: 409, data: { error: 'desk is not connected, so nothing can be installed on it' } } })
    await expect(installMachineAdapter(device!.id, 'gemini')).rejects.toMatchObject({ response: { status: 409 } })
  })

  it('answers 404 for a machine that is not on the account', async () => {
    await expect(setMachineAgents('nobody', [])).rejects.toMatchObject({ response: { status: 404, data: { error: 'no such machine' } } })
    await expect(deleteLocalAgentDevice('nobody')).rejects.toMatchObject({ response: { status: 404 } })
  })

  it('removes a machine, after which it is no longer listed', async () => {
    const [device] = await listLocalAgentDevices()
    expect(await deleteLocalAgentDevice(device!.id)).toEqual({ success: true })
    expect(await listLocalAgentDevices()).toEqual([])
  })
})

describe('root\'s My Machines page, as the browser asks for it', () => {
  it('makes a join code that carries the name the person picked for their Koala', async () => {
    const made = await createMyJoinCode('bobby')
    expect(made.command).toBe(`curl -fsSL ${backend.origin}/machine.sh | sh -s -- ${made.code}`)
    const id = await joined('tower', async () => made)
    const view = await listMyMachines()
    expect(view).toEqual({ koala: null, joins: [], machines: [objectWith({ id, name: 'tower', rootDir: '/home/me/tower', online: false, koalaWanted: true, holdsKoala: false })] })
  })

  it('shows a join as its machine reports it, and dismisses one that failed', async () => {
    const made = await createMyJoinCode()
    expect(await side!.accounts.reportJoinProgress(made.code, { stage: 'k3s', title: 'Installing k3s', state: 'failed', why: 'no space left on /var' })).toMatchObject({ ok: true })
    const { joins } = await listMyMachines()
    expect(joins).toEqual([{ id: anyOf(String), stage: 'k3s', title: 'Installing k3s', state: 'failed', why: 'no space left on /var', at: anyOf(String), expiresAt: made.expiresAt }])
    expect(await dismissMachineJoin(joins[0]!.id)).toEqual({ dismissed: true })
    expect((await listMyMachines()).joins).toEqual([])
    await expect(dismissMachineJoin(joins[0]!.id)).rejects.toMatchObject({ response: { status: 404, data: { error: 'no such join on your account' } } })
  })

  it('puts Koala on a machine on the mesh under the name the page sends, and the list then says it holds Koala', async () => {
    const { machines: [tower] } = await listMyMachines()
    await side!.accounts.recordMeshIp(tower!.id, '100.64.0.9')
    expect(await putKoalaOn(tower!.id, 'kangaroo')).toEqual({ placing: false })
    expect(await listMyMachines()).toMatchObject({ koala: { machineId: tower!.id, status: 'joined' }, machines: [{ id: tower!.id, holdsKoala: true, meshIp: '100.64.0.9' }] })
    expect((await backend.db.instances.getInstances((await backend.db.accounts.getUsers())[0]!.id))[0]).toMatchObject({ name: 'kangaroo' })
  })

  it('refuses to put Koala on a machine that is not the person\'s', async () => {
    await expect(putKoalaOn('nope', 'kangaroo')).rejects.toMatchObject({ response: { status: 404, data: { error: 'no such machine on your account' } } })
  })
})

describe('machines are the signed-in person\'s alone', () => {
  it('shows another person none of the first person\'s machines', async () => {
    await backend.signInAnother('second@koala.test')
    expect(await listLocalAgentDevices()).toEqual([])
    expect(await listMyMachines()).toEqual({ koala: null, joins: [], machines: [] })
  })
})
