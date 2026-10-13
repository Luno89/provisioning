import { planFor, type AgentDefinition, type BaseImage, type ImagePlan, type ToolDefinition } from '@koala/agent-engine';
import { contributionsOf, type WorkspaceFile } from './workspace-file.js';
import { serverContributions, type McpServerRecord } from './mcp-servers.js';

export interface WorkspaceInputs {
  agent: AgentDefinition;
  tools: readonly ToolDefinition[];
  file?: WorkspaceFile | undefined;
  servers?: readonly McpServerRecord[] | undefined;
}

export interface ComposedWorkspace {
  plan: ImagePlan;
  env: { name: string; value: string }[];
}

const languagesOf = (agent: AgentDefinition): string[] => [...(agent.environmentSpec?.languages ?? agent.environment.languages ?? [])];

export function withFileLanguages(agent: AgentDefinition, file: WorkspaceFile | undefined): AgentDefinition {
  const extra = (file?.languages ?? []).filter((language) => !languagesOf(agent).includes(language));
  if (extra.length === 0) return agent;
  const languages = [...languagesOf(agent), ...extra];
  return {
    ...agent,
    environment: { ...agent.environment, languages },
    ...(agent.environmentSpec ? { environmentSpec: { ...agent.environmentSpec, languages } } : {}),
  };
}

export function heldWorkspaceServers(agent: Pick<AgentDefinition, 'servers'>, servers: readonly McpServerRecord[] = []): McpServerRecord[] {
  const held = new Set(agent.servers ?? []);
  return servers.filter((server) => held.has(server.name) && server.runs.where === 'workspace');
}

function withServerLanguages(agent: AgentDefinition, servers: readonly McpServerRecord[]): AgentDefinition {
  const languages = servers.flatMap((server) => (server.runs.where === 'workspace' ? server.runs.languages ?? [] : []));
  return languages.length > 0 ? withFileLanguages(agent, { languages }) : agent;
}

export function composeWorkspace(inputs: WorkspaceInputs, bases: readonly BaseImage[]): ComposedWorkspace | undefined {
  const held = heldWorkspaceServers(inputs.agent, inputs.servers);
  const agent = withServerLanguages(withFileLanguages(inputs.agent, inputs.file), held);
  const plan = planFor(agent, inputs.tools, bases, [...(inputs.file ? contributionsOf(inputs.file) : []), ...held.flatMap(serverContributions)]);
  if (!plan) return undefined;
  return { plan, env: (inputs.file?.env ?? []).map((entry) => ({ name: entry.name, value: entry.value })) };
}
