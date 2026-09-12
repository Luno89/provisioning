import type { SamplingConfig } from '@koala/harness-types';
import { withBuiltIns } from '../lib/ownership.js';
import { capabilitiesOf, type EnvironmentCapabilities, type EnvironmentRequirement, type EnvironmentSpec } from './environment.js';
import { agentAsTool, describeTools, effectiveTools, type ToolContract, type WithheldTool } from './tools.js';
import type { RunBudget } from './run.js';

export interface AgentInterface {
  inputs?: Record<string, unknown> | undefined;
  outputs?: string[] | undefined;
  workspace?: boolean | undefined;
}

export interface AgentDefinition {
  slug: string;
  ownerId?: string | undefined;
  name: string;
  description: string;
  version: string;
  prompt: string;
  loop: string;
  tools: string[];
  agents?: string[] | undefined;
  budget: RunBudget;
  sampling?: SamplingConfig | undefined;
  model?: { endpointId?: string | null | undefined; reasoningEffort?: string | undefined } | undefined;
  environment: EnvironmentRequirement;
  environmentSpec?: EnvironmentSpec | undefined;
  interface?: AgentInterface | undefined;
}

export function visibleAgents(all: readonly AgentDefinition[], ownerId: string): AgentDefinition[] {
  return withBuiltIns(all, ownerId, (agent) => agent.slug);
}

export function resolveAgent(
  all: readonly AgentDefinition[],
  ownerId: string,
  slug: string,
): AgentDefinition | undefined {
  return visibleAgents(all, ownerId).find((agent) => agent.slug === slug);
}

export function isFork(agent: AgentDefinition): boolean {
  return agent.ownerId !== undefined;
}

export function needsWorkspace(agent: AgentDefinition): boolean {
  return agent.interface?.workspace === true;
}

export function callableAgents(
  agent: AgentDefinition,
  all: readonly AgentDefinition[],
  ownerId: string,
): AgentDefinition[] {
  const allowed = new Set(agent.agents ?? []);
  return visibleAgents(all, ownerId).filter((candidate) => allowed.has(candidate.slug));
}

export function agentTools(agent: AgentDefinition, callable: readonly AgentDefinition[]): ToolContract[] {
  return callable.map((callee) => agentAsTool({
    name: callee.slug,
    description: callee.description,
    ...(callee.interface?.inputs ? { inputs: callee.interface.inputs } : {}),
  }));
}

export function describeEnvironment(
  capabilities: EnvironmentCapabilities,
  spec?: EnvironmentSpec | undefined,
): string {
  if (!capabilities.terminal && !capabilities.filesystem) {
    return capabilities.egress
      ? 'You have no machine of your own this turn. You can reach the network, but you cannot run commands or read files.'
      : 'You have no machine of your own this turn. You cannot run commands, read files, or reach the network.';
  }

  const where = spec?.kind === 'machine'
    ? 'You are working directly on a real machine belonging to the person you are helping, not a disposable sandbox. Changes you make are real and persist.'
    : 'You are working in a disposable sandbox. It is thrown away when you are done, so anything worth keeping has to be committed or returned as an output.';

  const parts = [where];
  if (capabilities.languages.length > 0) parts.push(`Available: ${capabilities.languages.join(', ')}.`);
  if (!capabilities.egress) parts.push('This machine has no network access.');

  return parts.join(' ');
}

export interface PromptRequest {
  agent: AgentDefinition;
  capabilities: EnvironmentCapabilities;
  catalogue: readonly ToolContract[];
  callable?: readonly AgentDefinition[] | undefined;
  allowed?: 'granted' | 'none' | string[] | undefined;
  memory?: string | undefined;
  spec?: EnvironmentSpec | undefined;
}

export interface ComposedPrompt {
  text: string;
  tools: ToolContract[];
  withheld: WithheldTool[];
}

export function composeAgentPrompt(request: PromptRequest): ComposedPrompt {
  const delegates = agentTools(request.agent, request.callable ?? []);
  const catalogue = [...request.catalogue, ...delegates];

  const { tools, withheld } = effectiveTools({
    granted: [...request.agent.tools, ...delegates.map((tool) => tool.name)],
    catalogue,
    capabilities: request.capabilities,
    ...(request.allowed ? { allowed: request.allowed } : {}),
  });

  const sections = [request.agent.prompt.trim()];

  const environment = describeEnvironment(request.capabilities, request.spec);
  if (environment) sections.push(environment);

  const described = describeTools(tools);
  if (described) sections.push(`Tools you can use right now:\n${described}`);

  if (request.memory?.trim()) sections.push(request.memory.trim());

  const outputs = request.agent.interface?.outputs ?? [];
  if (outputs.length > 0) {
    sections.push(`When you are done, your answer must provide: ${outputs.join(', ')}.`);
  }

  return { text: sections.filter(Boolean).join('\n\n'), tools, withheld };
}

export function environmentFor(agent: AgentDefinition): EnvironmentSpec {
  if (agent.environmentSpec) return agent.environmentSpec;

  const wantsMachine = agent.environment.terminal || agent.environment.filesystem || agent.environment.workspace;
  if (!wantsMachine) {
    return {
      kind: 'none',
      lifecycle: 'invocation',
      ...(agent.environment.egress ? { egress: true } : {}),
    };
  }

  return {
    kind: 'sandbox',
    lifecycle: 'invocation',
    ...(agent.environment.languages ? { languages: [...agent.environment.languages] } : {}),
    egress: agent.environment.egress === true,
  };
}

export function capabilitiesFor(agent: AgentDefinition): EnvironmentCapabilities {
  return capabilitiesOf(environmentFor(agent));
}
