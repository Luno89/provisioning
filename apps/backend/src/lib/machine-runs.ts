import { effectiveMachineChoice, type MachineChoice } from '@koala/agent-engine/procedure';

export const EXTERNAL_TASK_PROCEDURE = 'external-agent-task';
export const EXTERNAL_CHAT_PROCEDURE = 'external-agent-chat';

export interface RunOn {
  modelId?: string | undefined;
  chat?: boolean | undefined;
}

export interface MachineRun {
  machine: MachineChoice;
  procedureId: string;
}

export function machineRunFor(on: RunOn | undefined, agentEndpointId: string | null | undefined, procedureId: string | undefined): MachineRun | undefined {
  const machine = effectiveMachineChoice(on?.modelId, agentEndpointId);
  if (!machine) return undefined;
  return { machine, procedureId: procedureId ?? (on?.chat ? EXTERNAL_CHAT_PROCEDURE : EXTERNAL_TASK_PROCEDURE) };
}
