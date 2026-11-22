import type { Database, LocalAgentDeviceMetadata } from '../../platform/index.js';

export interface MachineTokens {
  checkMachineToken(token: string): Promise<{ deviceId: string; until: number } | string>;
}

export interface MachineAdmission {
  device: LocalAgentDeviceMetadata;
  until: number;
}

export const NOT_THIS_KOALAS = 'this machine is not one of this Koala\'s: run the command from My Machines again';

export const machineAdmission = (db: Pick<Database, 'machines'>, tokens: MachineTokens, ownerId: string | undefined) =>
  async (token: string): Promise<MachineAdmission | string> => {
    const checked = await tokens.checkMachineToken(token);
    if (typeof checked === 'string') return `Unauthorized: ${checked}`;
    const device = (await db.machines.getLocalAgentDevices()).find((candidate) => candidate.id === checked.deviceId && candidate.ownerId === ownerId);
    return device ? { device, until: checked.until } : NOT_THIS_KOALAS;
  };

export const deviceByMachineToken = (db: Pick<Database, 'machines'>, tokens: MachineTokens | undefined, ownerId: string | undefined) => {
  const admit = tokens ? machineAdmission(db, tokens, ownerId) : undefined;
  return async (token: string): Promise<LocalAgentDeviceMetadata | undefined> => {
    const admitted = await admit?.(token);
    return admitted && typeof admitted !== 'string' ? admitted.device : undefined;
  };
};
