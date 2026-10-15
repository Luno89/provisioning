export const MACHINE_CHOICE_PREFIX = 'machine:';

export interface MachineChoice {
  deviceId: string;
  agent: string;
}

export const machineChoiceId = (choice: MachineChoice): string => `${MACHINE_CHOICE_PREFIX}${choice.deviceId}:${choice.agent}`;

export function machineChoice(id: string | null | undefined): MachineChoice | undefined {
  if (!id || !id.startsWith(MACHINE_CHOICE_PREFIX)) return undefined;
  const rest = id.slice(MACHINE_CHOICE_PREFIX.length);
  const split = rest.indexOf(':');
  if (split <= 0 || split === rest.length - 1) return undefined;
  return { deviceId: rest.slice(0, split), agent: rest.slice(split + 1) };
}

export const machineSessionKey = (choice: MachineChoice): string => `${choice.deviceId}:${choice.agent}`;

export function effectiveMachineChoice(modelId: string | null | undefined, agentEndpointId: string | null | undefined): MachineChoice | undefined {
  return machineChoice(modelId) ?? machineChoice(agentEndpointId);
}
