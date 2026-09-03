import type { PersonaPack } from '@koala/harness-types';
import type {
  AgentRunOptions, CheckpointDriver, ExtendBudgetDriver, SandboxDriver,
} from './agent-loop.js';
import type { WebTools } from './web-tools.js';
import type { Overrides } from './tunables.js';
import { WEB_TOOL_NAMES } from './leaf-tools.js';
import type { BudgetConfig } from '@koala/harness-types';
import type { RanAs } from './run-provenance.js';

export interface RunInputs {
  taskContext: string;
  sandbox: SandboxDriver;
  memoryContext?: string | undefined;
  bindingsContext?: string | undefined;
  sandboxSpec?: AgentRunOptions['sandboxSpec'] | undefined;
  contextTokens?: number | undefined;
  web?: WebTools | undefined;
  ranAs?: RanAs | undefined;
  systemPrompt?: string | undefined;
  extraInstructions?: string | undefined;
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
  budget: BudgetConfig,
  pack: Pick<PersonaPack, 'tools'> | null | undefined,
  inputs: RunInputs,
): Omit<AgentRunOptions, 'baseUrl' | 'model'> {
  const run = budget.run;
  const tools = pack?.tools ?? [];

  return {
    budget,
    taskContext: inputs.taskContext,
    sandbox: inputs.sandbox,
    ...(inputs.memoryContext ? { memoryContext: inputs.memoryContext } : {}),
    ...(inputs.bindingsContext ? { bindingsContext: inputs.bindingsContext } : {}),
    ...(inputs.sandboxSpec ? { sandboxSpec: inputs.sandboxSpec } : {}),
    ...(inputs.contextTokens ? { contextTokens: inputs.contextTokens } : {}),
    ...(inputs.ranAs ? { ranAs: inputs.ranAs } : {}),
    ...(inputs.systemPrompt ? { systemPrompt: inputs.systemPrompt } : {}),
    ...(inputs.extraInstructions ? { extraInstructions: inputs.extraInstructions } : {}),
    ...(inputs.web && wantsWeb(pack) ? { web: inputs.web } : {}),
    // A pack's grant list decides, and an empty one grants nothing. No pack at all is different:
    // there is no list to honour, so the loop falls back to the whole catalogue as it always did.
    ...(pack ? { allowTools: allowWithMcp(tools, inputs.remoteToolNames ?? []) } : {}),
    ...(inputs.remoteTools?.length ? { remoteTools: inputs.remoteTools } : {}),
    ...(inputs.callRemote ? { callRemote: inputs.callRemote } : {}),
    ...(inputs.checkpoint ? { checkpoint: inputs.checkpoint } : {}),
    ...(inputs.extendBudget ? { extendBudget: inputs.extendBudget } : {}),
    ...(inputs.saveMemory ? { saveMemory: inputs.saveMemory } : {}),
    // maxSteps/maxTokens are deliberately not set here — agent-loop.ts already falls back to
    // budget.run.steps/.tokens when unset, so budget.run is the single source now, not an
    // override layer on top of it.
    ...(run.pacing?.length ? { pacing: run.pacing } : {}),
    ...(run.withdraw
      ? { withdrawTools: { afterStep: run.withdraw.afterStep, names: run.withdraw.tools } }
      : {}),
  };
}
