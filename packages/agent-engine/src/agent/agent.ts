import type { SamplingConfig } from '@koala/harness-types';
import { withBuiltIns } from '../lib/ownership.js';
import { capabilitiesOf, type EnvironmentCapabilities, type EnvironmentRequirement, type EnvironmentSpec } from '@koala/engine-core/contracts';
import { agentAsTool, type ToolContract } from '@koala/engine-core/contracts';
import type { RunBudget } from '../runtime/run.js';

export interface PersonaFailure {
  when: string;
  says: string;
}

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

export function activeGrants(agent: Pick<Persona, 'egress'>): EgressGrant[] {
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

export interface Persona {
  slug: string;
  ownerId?: string | undefined;
  name: string;
  description: string;
  version: string;
  prompt: string;
  guidance: string;
  returns: string;
  failures: PersonaFailure[];
  procedure: string;
  tools: string[];
  agents?: string[] | undefined;
  budget?: RunBudget | undefined;
  sampling?: SamplingConfig | undefined;
  model?: { endpointId?: string | null | undefined; reasoningEffort?: string | undefined; replyCeiling?: number | undefined } | undefined;
  environment: EnvironmentRequirement;
  environmentSpec?: EnvironmentSpec | undefined;
  interface?: AgentInterface | undefined;
  egressMode?: EgressMode | undefined;
  egress?: EgressGrant[] | undefined;
}

export function visibleAgents(all: readonly Persona[], ownerId: string): Persona[] {
  return withBuiltIns(all, ownerId, (agent) => agent.slug);
}

export function resolveAgent(
  all: readonly Persona[],
  ownerId: string,
  slug: string,
): Persona | undefined {
  return visibleAgents(all, ownerId).find((agent) => agent.slug === slug);
}

export function isFork(agent: Persona): boolean {
  return agent.ownerId !== undefined;
}

export function needsWorkspace(agent: Persona): boolean {
  return agent.interface?.workspace === true;
}

export function callableAgents(
  agent: Persona,
  all: readonly Persona[],
  ownerId: string,
): Persona[] {
  const allowed = new Set(agent.agents ?? []);
  return visibleAgents(all, ownerId).filter((candidate) => allowed.has(candidate.slug));
}

export function agentTools(_agent: Persona, callable: readonly Persona[]): ToolContract[] {
  return callable.map((callee) => agentAsTool({
    name: callee.slug,
    description: callee.description,
    guidance: callee.guidance,
    returns: callee.returns,
    failures: callee.failures,
    ...(callee.interface?.inputs ? { inputs: callee.interface.inputs } : {}),
  }));
}

export function environmentFor(agent: Persona): EnvironmentSpec {
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

export function capabilitiesFor(agent: Persona): EnvironmentCapabilities {
  return capabilitiesOf(environmentFor(agent));
}

export type AgentDefinition = Persona;
