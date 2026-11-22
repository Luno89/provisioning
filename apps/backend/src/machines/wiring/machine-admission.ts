import type { Database, LocalAgentDeviceMetadata } from '../../platform/index.js';

type MachineAccessCheck = (token: string) => Promise<{ deviceId: string; until: number } | string>;

export interface MachineTokens {
  checkMachineToken: MachineAccessCheck;
  checkMetricsToken: MachineAccessCheck;
}

export interface MachineAdmission {
  device: LocalAgentDeviceMetadata;
  until: number;
}

export const NOT_THIS_KOALAS = 'this machine is not one of this Koala\'s: run the command from My Machines again';

const admissionBy = (db: Pick<Database, 'machines'>, check: MachineAccessCheck, ownerId: string | undefined) =>
  async (token: string): Promise<MachineAdmission | string> => {
    const checked = await check(token);
    if (typeof checked === 'string') return `Unauthorized: ${checked}`;
    const device = (await db.machines.getLocalAgentDevices()).find((candidate) => candidate.id === checked.deviceId && candidate.ownerId === ownerId);
    return device ? { device, until: checked.until } : NOT_THIS_KOALAS;
  };

export const machineAdmission = (db: Pick<Database, 'machines'>, tokens: Pick<MachineTokens, 'checkMachineToken'>, ownerId: string | undefined) =>
  admissionBy(db, (token) => tokens.checkMachineToken(token), ownerId);

export const metricsAdmission = (db: Pick<Database, 'machines'>, tokens: Pick<MachineTokens, 'checkMetricsToken'>, ownerId: string | undefined) =>
  admissionBy(db, (token) => tokens.checkMetricsToken(token), ownerId);

export const deviceByMachineToken = (db: Pick<Database, 'machines'>, tokens: Pick<MachineTokens, 'checkMachineToken'> | undefined, ownerId: string | undefined) => {
  const admit = tokens ? machineAdmission(db, tokens, ownerId) : undefined;
  return async (token: string): Promise<LocalAgentDeviceMetadata | undefined> => {
    const admitted = await admit?.(token);
    return admitted && typeof admitted !== 'string' ? admitted.device : undefined;
  };
};
