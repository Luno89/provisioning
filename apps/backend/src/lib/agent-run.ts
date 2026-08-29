import type { PersonaPack } from '@koala/harness-types';
import type {
  AgentRunOptions, CheckpointDriver, ExtendBudgetDriver, SandboxDriver,
} from './agent-loop.js';
import type { WebTools } from './web-tools.js';
import type { Overrides } from './tunables.js';
import { WEB_TOOL_NAMES } from './leaf-tools.js';

export interface RunInputs {
  taskContext: string;
  sandbox: SandboxDriver;
  overrides: Overrides;
  memoryContext?: string | undefined;
  bindingsContext?: string | undefined;
  sandboxSpec?: AgentRunOptions['sandboxSpec'] | undefined;
  contextTokens?: number | undefined;
  web?: WebTools | undefined;
  fromProfile?: string[] | undefined;
  fromPersona?: string[] | undefined;
  fromPack?: string[] | undefined;
  remoteTools?: { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }[] | undefined;
  remoteToolNames?: string[] | undefined;
  callRemote?: ((name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean } | undefined>) | undefined;
  checkpoint?: CheckpointDriver | undefined;
  extendBudget?: ExtendBudgetDriver | undefined;
  saveMemory?: AgentRunOptions['saveMemory'];
}

export function wantsMcp(pack: Pick<PersonaPack, 'mcp'> | null | undefined): string[] {
  return pack?.mcp ?? [];
}

export function allowWithMcp(declared: string[], remoteNames: string[]): string[] {
  if (!declared.length) return [];
  return [...declared, ...remoteNames];
}

export function wantsWeb(pack: Pick<PersonaPack, 'tools'> | null | undefined): boolean {
  const tools = pack?.tools ?? [];
  return tools.some((t) => (WEB_TOOL_NAMES as readonly string[]).includes(t));
}

export function agentRunOptions(
  pack: Pick<PersonaPack, 'tools' | 'workspace'> | null | undefined,
  inputs: RunInputs,
): Omit<AgentRunOptions, 'baseUrl' | 'model'> {
  const run = pack?.workspace?.run ?? {};
  const tools = pack?.tools ?? [];

  return {
    taskContext: inputs.taskContext,
    sandbox: inputs.sandbox,
    overrides: inputs.overrides,
    ...(inputs.memoryContext ? { memoryContext: inputs.memoryContext } : {}),
    ...(inputs.bindingsContext ? { bindingsContext: inputs.bindingsContext } : {}),
    ...(inputs.sandboxSpec ? { sandboxSpec: inputs.sandboxSpec } : {}),
    ...(inputs.contextTokens ? { contextTokens: inputs.contextTokens } : {}),
    ...(inputs.fromProfile?.length ? { fromProfile: inputs.fromProfile } : {}),
    ...(inputs.fromPersona?.length ? { fromPersona: inputs.fromPersona } : {}),
    ...(inputs.fromPack?.length ? { fromPack: inputs.fromPack } : {}),
    ...(inputs.web && wantsWeb(persona) ? { web: inputs.web } : {}),
    ...(tools.length ? { allowTools: allowWithMcp(tools, inputs.remoteToolNames ?? []) } : {}),
    ...(inputs.remoteTools?.length ? { remoteTools: inputs.remoteTools } : {}),
    ...(inputs.callRemote ? { callRemote: inputs.callRemote } : {}),
    ...(inputs.checkpoint ? { checkpoint: inputs.checkpoint } : {}),
    ...(inputs.extendBudget ? { extendBudget: inputs.extendBudget } : {}),
    ...(inputs.saveMemory ? { saveMemory: inputs.saveMemory } : {}),
    ...(run.maxSteps ? { maxSteps: run.maxSteps } : {}),
    ...(run.maxTokens ? { maxTokens: run.maxTokens } : {}),
    ...(run.pacing?.length ? { pacing: run.pacing } : {}),
    ...(run.withdraw
      ? { withdrawTools: { afterStep: run.withdraw.afterStep, names: run.withdraw.tools } }
      : {}),
  };
}
