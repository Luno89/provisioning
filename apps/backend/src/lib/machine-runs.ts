import { effectiveMachineChoice, type MachineChoice, type Procedure } from '@koala/agent-engine/procedure';

export const EXTERNAL_TASK_PROCEDURE = 'external-agent-task';
export const EXTERNAL_CHAT_PROCEDURE = 'external-agent-chat';

export interface RunOn {
  modelId?: string | undefined;
  chat?: boolean | undefined;
}

export const WHERE_IT_RUNS = 'where-it-runs';

export interface MachineRun {
  machine: MachineChoice;
  procedureId: string;
  inPlace: boolean;
}

export const branchesForMachine = (procedure: Pick<Procedure, 'nodes'> | undefined): boolean =>
  Boolean(procedure?.nodes.some((node) => node.kind === WHERE_IT_RUNS));

export function machineRunFor(
  on: RunOn | undefined,
  agentEndpointId: string | null | undefined,
  procedureId: string | undefined,
  own?: Pick<Procedure, 'id' | 'nodes'> | undefined,
): MachineRun | undefined {
  const machine = effectiveMachineChoice(on?.modelId, agentEndpointId);
  if (!machine) return undefined;
  if (procedureId) return { machine, procedureId, inPlace: false };
  if (!on?.chat && own && branchesForMachine(own)) return { machine, procedureId: own.id, inPlace: true };
  return { machine, procedureId: on?.chat ? EXTERNAL_CHAT_PROCEDURE : EXTERNAL_TASK_PROCEDURE, inPlace: false };
}
