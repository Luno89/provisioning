import { machineChoice } from '@koala/agent-engine/procedure';
import type { WorkspaceSource } from './environments.js';

export interface KnownMachine {
  id: string;
  ownerId: string;
  name: string;
}

export function createMachineWorkspaces(machines: { list(): Promise<readonly KnownMachine[]> }): WorkspaceSource {
  return {
    async forRun(ticket) {
      const chosen = machineChoice(ticket.modelId);
      if (!chosen) return undefined;
      const device = (await machines.list()).find((one) => one.id === chosen.deviceId && one.ownerId === ticket.ownerId);
      return device ? { kind: 'machine', deviceId: device.id, deviceName: device.name } : undefined;
    },
  };
}
