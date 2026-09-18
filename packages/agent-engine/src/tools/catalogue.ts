import type { EnvironmentRequirement, ToolBinding, ToolContract } from '@koala/engine-core';

export type ToolEffect = 'read' | 'write' | 'propose';

export type ToolStatus = 'draft' | 'approved';

export interface JsonSchema {
  type: 'object';
  properties: Record<string, { type: string; description: string; enum?: string[]; items?: unknown }>;
  required?: string[];
}

export type Install =
  | { via: 'dnf' | 'apt' | 'pip' | 'npm'; packages: string[] }
  | { via: 'script'; run: string }
  | { via: 'base' };

export interface Reachability {
  build?: string[] | undefined;
  run?: string[] | undefined;
}

export interface Failure {
  when: string;
  says: string;
}

export interface ToolDefinition {
  name: string;
  ownerId?: string | undefined;
  summary: string;
  guidance?: string | undefined;
  binding: ToolBinding;
  effect: ToolEffect;
  parameters: JsonSchema;

  returns: string;
  failures: Failure[];

  requires?: EnvironmentRequirement | undefined;
  needsBinaries?: string[] | undefined;
  provides?: string[] | undefined;
  install?: Install | undefined;
  reaches?: Reachability | undefined;
  secrets?: string[] | undefined;

  status: ToolStatus;
  approvedBy?: string | undefined;
  approvedAt?: string | undefined;
  replaces?: string[] | undefined;
}

export interface CatalogueProblem {
  tool: string;
  message: string;
}

export function checkDefinition(tool: ToolDefinition): CatalogueProblem[] {
  const problems: CatalogueProblem[] = [];
  const say = (message: string) => problems.push({ tool: tool.name, message });

  if (!/^[a-z][a-z0-9_]*$/.test(tool.name)) {
    say('a tool name is lower case, digits and underscores, starting with a letter');
  }
  if (!tool.summary.trim()) say('has no summary, so nothing tells the model what it does');

  const names = Object.keys(tool.parameters.properties);
  for (const required of tool.parameters.required ?? []) {
    if (!names.includes(required)) say(`requires "${required}", which it does not define`);
  }
  for (const [name, schema] of Object.entries(tool.parameters.properties)) {
    if (!schema.description?.trim()) say(`argument "${name}" has no description`);
  }

  if (tool.binding !== 'environment') {
    if (tool.needsBinaries?.length || tool.requires || tool.install || tool.provides?.length) {
      say('only an environment-bound tool runs inside the workspace, so only it can need installing');
    }
    if (tool.reaches?.build?.length) {
      say('nothing is built for this tool, so it has nothing to reach at build time');
    }
  }

  if (tool.needsBinaries?.length && !tool.install) {
    say(`needs ${tool.needsBinaries.join(', ')} but does not say how to install it`);
  }

  if (!tool.returns.trim()) say('does not say what it returns, so the model cannot plan past it');

  if (tool.failures.length === 0) {
    say('lists no failures — every tool can be called wrongly, and the model needs to know how it will be told');
  }
  for (const failure of tool.failures) {
    if (!failure.when.trim() || !failure.says.trim()) say('has a failure with no condition or no message');
  }

  if (tool.status === 'approved' && !tool.approvedBy) {
    say('is marked approved but nobody is recorded as approving it');
  }

  return problems;
}

export function checkCatalogue(tools: readonly ToolDefinition[]): CatalogueProblem[] {
  const problems = tools.flatMap(checkDefinition);
  const seen = new Set<string>();

  for (const tool of tools) {
    if (seen.has(tool.name)) problems.push({ tool: tool.name, message: 'is defined twice' });
    seen.add(tool.name);
  }

  return problems;
}

export function asContract(tool: ToolDefinition): ToolContract {
  const description = tool.guidance ? `${tool.summary}. ${tool.guidance}` : tool.summary;
  return {
    name: tool.name,
    description,
    binding: tool.binding,
    parameters: tool.parameters as unknown as Record<string, unknown>,
    ...(tool.guidance ? { usageGuidance: tool.guidance } : {}),
    ...(tool.requires ? { requires: tool.requires } : {}),
  };
}

export function approved(tools: readonly ToolDefinition[]): ToolDefinition[] {
  return tools.filter((tool) => tool.status === 'approved');
}

export function contractsFor(
  tools: readonly ToolDefinition[],
  include: ToolStatus[] = ['approved'],
): ToolContract[] {
  return tools.filter((tool) => include.includes(tool.status)).map(asContract);
}
