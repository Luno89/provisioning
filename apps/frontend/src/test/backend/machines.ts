import type { Socket } from 'socket.io'
import { afterAll } from 'vitest'
import type { Site } from './site'
import { MachineService } from '../../../../backend/src/machines/services/MachineService'
import { MachineAccounts } from '../../../../backend/src/machines/services/MachineAccounts'
import { KoalaInstalls } from '../../../../backend/src/machines/services/KoalaInstalls'
import { askDevice, dropDevice, localAgentStatus, registerDevice, tellDevice } from '../../../../backend/src/machines/lib/local-agent-registry'
import { ProjectRepoService } from '../../../../backend/src/projects/services/ProjectRepoService'
import { InstanceService, type PoolWorkflows } from '../../../../backend/src/instances/services/InstanceService'
import { generateIdentityKey, identityKeysFrom } from '../../../../backend/src/instances/lib/identity-token'
import type { GiteaService } from '../../../../backend/src/projects/services/GiteaService'
import type { LocalAgentDeviceMetadata } from '../../../../backend/src/platform/lib/types'
import { machineSides, type MachineSides } from '../../../../backend/src/machines/wiring/sides'
import { koalaOfOwner } from '../../../../backend/src/machines/wiring/machines'
import { myMachinesRouter } from '../../../../backend/src/machines/routes/my-machines'
import type { InstallWorkflows } from '../../../../backend/src/machines/services/KoalaInstalls'
import { roleFromEnv, type RoleConfig } from '../../../../backend/src/platform/lib/platform-role'

export const DATA_KEY = 'frontend-integration-data-key'

export interface Machines {
  machines: MachineService
  accounts: MachineAccounts
  join: (name: string, code: string) => Promise<string>
  agents: (deviceId: string, agents: NonNullable<LocalAgentDeviceMetadata['agents']>) => Promise<void>
  connect: (deviceId: string) => Promise<void>
}

export interface RootSides {
  role: RoleConfig
  sides: MachineSides
  started: string[]
  places: InstanceService
}

export interface RootSidesOptions {
  pool?: PoolWorkflows
}

export async function rootSidesOf(site: Site, options: RootSidesOptions = {}): Promise<RootSides> {
  const { db, io, origin, api } = site
  const role = roleFromEnv({ ROLE: 'root', ROOT_IDENTITY_KEY: generateIdentityKey() })
  let made: MachineSides | undefined
  const sidesMade = (): MachineSides => {
    if (!made) throw new Error('root\'s machine sides are asked for before they are made')
    return made
  }
  const installs = () => {
    const found = sidesMade().installs
    if (!found) throw new Error('root\'s machine sides came up without installs, which root always follows')
    return found
  }
  const moving = options.pool ? {
    pool: { slots: 1, trialDays: 30 },
    moves: { joinCode: (ownerId: string, koalaName: string) => sidesMade().accounts!.createJoinCode(ownerId, koalaName, true), poolClusterId: (name: string) => `pool-${name}` },
    installs: {
      setupHeard: (installId: string, report: Parameters<NonNullable<MachineSides['installs']>['setupHeard']>[1]) => installs().setupHeard(installId, report),
      progressHeard: (installId: string, progress: Parameters<NonNullable<MachineSides['installs']>['progressHeard']>[1]) => installs().progressHeard(installId, progress),
      stop: (installId: string) => installs().stop(installId),
    },
  } : {}
  const places = new InstanceService(db, { rootUrl: origin, rootPublicKeys: () => ['PEM'], meshLoginServer: 'https://mesh.koala.test', registry: '100.64.0.1:5001', imageTag: 'v1', domain: '', ...moving },
    { createPreAuthKey: async () => ({ key: 'preauth' }), removeNode: async () => undefined }, () => new Date(), () => undefined, options.pool)
  const started: string[] = []
  const workflows: InstallWorkflows = {
    start: async (installId) => { started.push(installId) },
    progress: async () => undefined,
    setup: async () => undefined,
    reconnected: async () => undefined,
    cancel: async () => undefined,
  }
  const sides = machineSides({
    role, db, io, dataKey: DATA_KEY, publicUrl: origin, meshLoginServer: 'https://mesh.koala.test',
    mesh: { createPreAuthKey: async () => ({ key: 'preauth' }), removeNode: async () => undefined },
    devices: { status: localAgentStatus, tell: tellDevice, ask: askDevice, drop: dropDevice },
    projects: new ProjectRepoService(db, {} as GiteaService, DATA_KEY),
    instances: () => ({ places }),
    installWorkflows: workflows,
  })
  made = sides
  if (!sides.accounts || !sides.installsWatched) throw new Error('root\'s machine sides came up without accounts, which root always holds')
  afterAll(() => sides.installsWatched?.close())
  await sides.installsWatched.ready
  api.use('/my-machines', myMachinesRouter({ accounts: sides.accounts, koalaOf: koalaOfOwner(db) }))
  return { role, sides, started, places }
}

export function machinesOf({ db, origin }: Site): Machines {
  const instances = new InstanceService(db, { rootUrl: origin, rootPublicKeys: () => ['PEM'], meshLoginServer: 'https://mesh.koala.test', registry: '100.64.0.1:5001', imageTag: 'v1', domain: '' },
    { createPreAuthKey: async () => ({ key: 'preauth' }), removeNode: async () => undefined })
  const machines: MachineService = new MachineService({
    store: db.machines,
    devices: { status: localAgentStatus, tell: tellDevice, ask: askDevice, drop: dropDevice },
    projects: new ProjectRepoService(db, {} as GiteaService, DATA_KEY),
    accounts: { createJoinCode: (ownerId) => accounts.createJoinCode(ownerId), remove: (ownerId, id) => accounts.remove(ownerId, id) },
  })
  const accounts: MachineAccounts = new MachineAccounts({
    store: db.machines,
    signing: identityKeysFrom(generateIdentityKey()),
    settings: { url: origin, meshLoginServer: 'https://mesh.koala.test' },
    mesh: { createPreAuthKey: async () => ({ key: 'preauth' }), removeNode: async () => undefined },
    koala: { of: async () => ({ url: origin, audience: 'site-instance' }) },
    followers: { joined: (machine) => machines.adopt(machine), removed: (machine) => machines.forget(machine), changed: async () => undefined },
    toOwner: { machinesChanged: () => undefined },
    toMachines: { removed: () => false, koala: () => false, online: () => false },
    installs: new KoalaInstalls({
      devices: () => db.machines.getLocalAgentDevices(),
      places: () => instances,
      workflows: { start: async () => undefined, progress: async () => undefined, setup: async () => undefined, reconnected: async () => undefined, cancel: async () => undefined },
      toMachines: { placeKoala: async () => false },
      toOwner: { installChanged: () => undefined },
    }),
  })
  return {
    machines,
    accounts,
    join: async (name, code) => {
      const outcome = await accounts.join(code, { hostname: name, rootDir: `/home/me/${name}` })
      if (!outcome.ok) throw new Error(outcome.error)
      return outcome.value.deviceId
    },
    agents: async (deviceId, agents) => { await db.machines.updateLocalAgentDevice(deviceId, { set: { agents } }) },
    connect: async (deviceId) => {
      const socket = {
        connected: true,
        disconnect: () => socket,
        once: () => socket,
        off: () => socket,
        emit: () => true,
      } as unknown as Socket
      const device = (await db.machines.getLocalAgentDevices()).find((candidate) => candidate.id === deviceId)
      if (!device) throw new Error(`no machine ${deviceId} to connect`)
      registerDevice(device.id, device.ownerId, device.rootDir, socket)
    },
  }
}
