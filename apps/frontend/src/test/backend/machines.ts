import type { Socket } from 'socket.io'
import { afterAll } from 'vitest'
import type { Site } from './site'
import { MachineService } from '../../../../backend/src/machines/services/MachineService'
import { MachineAccounts } from '../../../../backend/src/machines/services/MachineAccounts'
import { KoalaInstalls } from '../../../../backend/src/machines/services/KoalaInstalls'
import { askDevice, dropDevice, localAgentStatus, registerDevice, tellDevice } from '../../../../backend/src/machines/lib/local-agent-registry'
import { ProjectRepoService } from '../../../../backend/src/projects/services/ProjectRepoService'
import { InstanceService } from '../../../../backend/src/instances/services/InstanceService'
import { generateIdentityKey } from '../../../../backend/src/instances/lib/identity-token'
import type { GiteaService } from '../../../../backend/src/projects/services/GiteaService'
import type { LocalAgentDeviceMetadata } from '../../../../backend/src/platform/lib/types'
import { machineSides, type MachineSides } from '../../../../backend/src/machines/wiring/sides'
import { DependencyStates } from '../../../../backend/src/platform/services/DependencyStates'
import { koalaOfOwner } from '../../../../backend/src/machines/wiring/machines'
import { myMachinesRouter } from '../../../../backend/src/machines/routes/my-machines'
import type { InstallWorkflows } from '../../../../backend/src/machines/services/KoalaInstalls'
import { roleFromEnv, type RoleConfig } from '../../../../backend/src/platform/lib/platform-role'
import { testInstanceClients } from '../../../../backend/src/instances/testing/placed-koala'
import { machineClientsAt } from '../../../../backend/src/instances/testing/registration-code'

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

export async function rootSidesOf(site: Site): Promise<RootSides> {
  const { db, io, origin, api } = site
  const role = roleFromEnv({ ROLE: 'root', ROOT_IDENTITY_KEY: generateIdentityKey() })
  const places = new InstanceService(db, { rootUrl: origin, rootPublicKeys: () => ['PEM'], ...testInstanceClients, meshLoginServer: 'https://mesh.koala.test', registry: '100.64.0.1:5001', imageTag: 'v1', domain: '' },
    { createPreAuthKey: async () => ({ key: 'preauth' }), removeNode: async () => undefined }, () => new Date(), () => undefined)
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
    clients: machineClientsAt(db),
    devices: { status: localAgentStatus, tell: tellDevice, ask: askDevice, drop: dropDevice },
    projects: new ProjectRepoService(db, {} as GiteaService, DATA_KEY),
    instances: () => ({ places }),
    installWorkflows: workflows,
    dependencies: new DependencyStates({ process: 'backend', described: ['mongo', 'temporal'] }),
  })
  if (!sides.accounts || !sides.watched) throw new Error('root\'s machine sides came up without accounts, which root always holds')
  afterAll(() => sides.watched?.close())
  await sides.watched.ready
  api.use('/my-machines', myMachinesRouter({ accounts: sides.accounts, koalaOf: koalaOfOwner(db) }))
  return { role, sides, started, places }
}

export function machinesOf({ db, origin }: Site): Machines {
  const instances = new InstanceService(db, { rootUrl: origin, rootPublicKeys: () => ['PEM'], ...testInstanceClients, meshLoginServer: 'https://mesh.koala.test', registry: '100.64.0.1:5001', imageTag: 'v1', domain: '' },
    { createPreAuthKey: async () => ({ key: 'preauth' }), removeNode: async () => undefined })
  const machines: MachineService = new MachineService({
    store: db.machines,
    devices: { status: localAgentStatus, tell: tellDevice, ask: askDevice, drop: dropDevice },
    projects: new ProjectRepoService(db, {} as GiteaService, DATA_KEY),
    accounts: { createJoinCode: (ownerId) => accounts.createJoinCode(ownerId), remove: (ownerId, id) => accounts.remove(ownerId, id) },
  })
  const accounts: MachineAccounts = new MachineAccounts({
    store: db.machines,
    clients: machineClientsAt(db),
    settings: { url: origin, meshLoginServer: 'https://mesh.koala.test' },
    mesh: { createPreAuthKey: async () => ({ key: 'preauth' }), removeNode: async () => undefined },
    koala: { of: async () => ({ url: origin, audience: 'site-instance' }) },
    followers: { joined: (machine) => machines.adopt(machine), removed: (machine) => machines.forget(machine), changed: async () => undefined },
    toOwner: { machinesChanged: () => undefined },
    toMachines: { removed: () => false, koala: () => false, online: () => false },
    installs: new KoalaInstalls({
      devices: () => db.machines.getLocalAgentDevices(),
      callers: machineClientsAt(db),
      places: () => instances,
      workflows: { start: async () => undefined, progress: async () => undefined, setup: async () => undefined, reconnected: async () => undefined, cancel: async () => undefined },
      toMachines: { placeKoala: async () => false, stopKoala: () => false },
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
