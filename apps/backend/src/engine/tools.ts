import type { EnvironmentCapabilities, EnvironmentRequirement } from './environment.js';
import { unmetRequirements } from './environment.js';

export type ToolBinding = 'platform' | 'network' | 'environment';

export interface ToolContract {
  name: string;
  description: string;
  binding: ToolBinding;
  requires?: EnvironmentRequirement | undefined;
  parameters?: Record<string, unknown> | undefined;
  usageGuidance?: string | undefined;
}

export interface WithheldTool {
  name: string;
  why: string;
}

export interface EffectiveToolsRequest {
  granted: string[];
  catalogue: ToolContract[];
  capabilities: EnvironmentCapabilities;
  allowed?: 'granted' | 'none' | string[] | undefined;
}

export interface EffectiveTools {
  tools: ToolContract[];
  withheld: WithheldTool[];
}

const impliedRequirement = (tool: ToolContract): EnvironmentRequirement => {
  if (tool.requires) return tool.requires;
  if (tool.binding === 'environment') return { terminal: true, filesystem: true };
  if (tool.binding === 'network') return { egress: true };
  return {};
};

export function effectiveTools(request: EffectiveToolsRequest): EffectiveTools {
  const { granted, catalogue, capabilities } = request;
  const allowed = request.allowed ?? 'granted';

  if (allowed === 'none') {
    return { tools: [], withheld: granted.map((name) => ({ name, why: 'this step offers no tools' })) };
  }

  const byName = new Map(catalogue.map((tool) => [tool.name, tool]));
  const permitted = Array.isArray(allowed) ? new Set(allowed) : undefined;

  const tools: ToolContract[] = [];
  const withheld: WithheldTool[] = [];

  for (const name of granted) {
    const tool = byName.get(name);
    if (!tool) {
      withheld.push({ name, why: 'no tool by that name is registered' });
      continue;
    }

    if (permitted && !permitted.has(name)) {
      withheld.push({ name, why: 'this step does not offer that tool' });
      continue;
    }

    const unmet = unmetRequirements(impliedRequirement(tool), capabilities);
    if (unmet.length > 0) {
      withheld.push({ name, why: unmet.map((entry) => entry.detail).join('; ') });
      continue;
    }

    tools.push(tool);
  }

  return { tools, withheld };
}

export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export function toolSchemas(tools: ToolContract[]): ToolSchema[] {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? { type: 'object', properties: {} },
    },
  }));
}

export function describeTools(tools: ToolContract[]): string {
  if (tools.length === 0) return '';
  return tools
    .map((tool) => `- ${tool.name}: ${tool.description}${tool.usageGuidance ? ` ${tool.usageGuidance}` : ''}`)
    .join('\n');
}

export interface AgentToolOptions {
  name: string;
  description: string;
  inputs?: Record<string, unknown> | undefined;
}

export function agentAsTool(options: AgentToolOptions): ToolContract {
  return {
    name: options.name,
    description: options.description,
    binding: 'platform',
    parameters: options.inputs ?? { type: 'object', properties: {} },
  };
}
