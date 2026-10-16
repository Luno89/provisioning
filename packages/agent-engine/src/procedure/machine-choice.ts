export const MACHINE_CHOICE_PREFIX = 'machine:';

export interface MachineChoice {
  deviceId: string;
  agent: string;
  model?: string | undefined;
}

export const machineChoiceId = (choice: MachineChoice): string =>
  `${MACHINE_CHOICE_PREFIX}${choice.deviceId}:${choice.agent}${choice.model ? `:${encodeURIComponent(choice.model)}` : ''}`;

export function machineChoice(id: string | null | undefined): MachineChoice | undefined {
  if (!id || !id.startsWith(MACHINE_CHOICE_PREFIX)) return undefined;
  const [deviceId, agent, model, ...extra] = id.slice(MACHINE_CHOICE_PREFIX.length).split(':');
  if (!deviceId || !agent || extra.length || model === '') return undefined;
  let decoded: string | undefined;
  try {
    decoded = model === undefined ? undefined : decodeURIComponent(model);
  } catch {
    return undefined;
  }
  return { deviceId, agent, ...(decoded ? { model: decoded } : {}) };
}

export const machineSessionKey = (choice: MachineChoice): string =>
  `${choice.deviceId}:${choice.agent}${choice.model ? `:${encodeURIComponent(choice.model)}` : ''}`;

export function effectiveMachineChoice(modelId: string | null | undefined, agentEndpointId: string | null | undefined): MachineChoice | undefined {
  return machineChoice(modelId) ?? machineChoice(agentEndpointId);
}
