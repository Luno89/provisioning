import type { SamplingConfig } from '@koala/harness-types';
import { withBuiltIns } from '../lib/ownership.js';
import { capabilitiesOf, type EnvironmentCapabilities, type EnvironmentRequirement, type EnvironmentSpec } from '@koala/engine-core';
import { agentAsTool, type ToolContract } from '@koala/engine-core';
import type { RunBudget } from './run.js';

export interface AgentInterface {
  inputs?: Record<string, unknown> | undefined;
  outputs?: string[] | undefined;
  workspace?: boolean | undefined;
}

export type EgressMode = 'none' | 'declared' | 'request' | 'auto';

export interface EgressGrant {
  host: string;
  ports?: number[] | undefined;
  approvedBy: string;
  approvedAt: string;
  reason?: string | undefined;
  revokedAt?: string | undefined;
  revokedBy?: string | undefined;
}

export function activeGrants(agent: Pick<AgentDefinition, 'egress'>): EgressGrant[] {
  return (agent.egress ?? []).filter((grant) => !grant.revokedAt);
}

export function revokeGrant(
  grants: readonly EgressGrant[],
  host: string,
  by: string,
  at: string,
): EgressGrant[] {
  return grants.map((grant) =>
    (grant.host === host && !grant.revokedAt
      ? { ...grant, revokedAt: at, revokedBy: by }
      : grant));
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
  egressMode?: EgressMode | undefined;
  egress?: EgressGrant[] | undefined;
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
