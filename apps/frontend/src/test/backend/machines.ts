import type { Socket } from 'socket.io'
import type { Site } from './site'
import { MachineService } from '../../../../backend/src/machines/services/MachineService'
import { MachineAccounts } from '../../../../backend/src/machines/services/MachineAccounts'
import { askDevice, dropDevice, localAgentStatus, registerDevice, tellDevice } from '../../../../backend/src/machines/lib/local-agent-registry'
import { ProjectRepoService } from '../../../../backend/src/projects/services/ProjectRepoService'
import { InstanceService } from '../../../../backend/src/instances/services/InstanceService'
import { generateIdentityKey, identityKeysFrom } from '../../../../backend/src/instances/lib/identity-token'
import type { GiteaService } from '../../../../backend/src/projects/services/GiteaService'
import type { LocalAgentDeviceMetadata } from '../../../../backend/src/platform/lib/types'

export const DATA_KEY = 'frontend-integration-data-key'

export interface Machines {
  machines: MachineService
  accounts: MachineAccounts
  join: (name: string, code: string) => Promise<string>
  agents: (deviceId: string, agents: NonNullable<LocalAgentDeviceMetadata['agents']>) => Promise<void>
  connect: (deviceId: string) => Promise<void>
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
    toMachines: { removed: () => false, koala: () => false, placeKoala: async () => false, online: () => false },
    placer: instances,
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
