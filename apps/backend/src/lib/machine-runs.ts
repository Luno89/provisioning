import { effectiveMachineChoice, machineChoice, type MachineChoice, type Procedure } from '@koala/agent-engine/procedure';

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

export interface AccountDefault {
  modelId?: string | null | undefined;
  overrides?: boolean | undefined;
}

export function accountMachineFor(
  on: RunOn | undefined,
  agentEndpointId: string | null | undefined,
  account: AccountDefault | undefined,
  own: Pick<Procedure, 'nodes'> | undefined,
): string | undefined {
  if (!on || on.modelId) return undefined;
  if (agentEndpointId && !account?.overrides) return undefined;
  const chosen = account?.modelId;
  if (!chosen || !machineChoice(chosen)) return undefined;
  return on.chat || branchesForMachine(own) ? chosen : undefined;
}

export const accountDefaultOf = (user: { space?: unknown; defaultModelId?: string | undefined; globalModelOverride?: boolean | undefined } | undefined): AccountDefault | undefined =>
  user && !user.space ? { modelId: user.defaultModelId, overrides: user.globalModelOverride === true } : undefined;

export const MACHINE_DEFAULT_NEEDS_MODEL = 'Your default is an agent on your machine, and this work cannot be handed to a machine. '
  + 'Add a model in Studio → Models, or give this agent a model of its own.';
