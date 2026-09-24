import {
  describeForDelegation,
  describeMachine,
  describeNoEnvironment,
  describeWorkspace,
  type RunWorkspace,
} from '../environment/workspace.js';
import {
  effectiveTools,
  type EnvironmentCapabilities,
  type ToolContract,
  type WithheldTool,
} from '@koala/engine-core/contracts';
import { agentTools, needsWorkspace, type AgentDefinition, type EgressMode } from '../agent/agent.js';

export type { EgressMode } from '../agent/agent.js';

export type ResolvedEnvironment =
  | { kind: 'none'; egress: boolean; bases?: readonly string[] | undefined }
  | { kind: 'sandbox'; workspace: RunWorkspace; worktree?: string | undefined }
  | { kind: 'machine'; deviceName: string; root: string; egressMode: EgressMode };

export interface ContextRequest {
  agent: AgentDefinition;
  environment: ResolvedEnvironment;
  capabilities: EnvironmentCapabilities;
  catalogue: readonly ToolContract[];
  callable?: readonly AgentDefinition[] | undefined;
  allowed?: 'granted' | 'none' | string[] | undefined;
  memory?: string | undefined;
}

export interface ComposedContext {
  text: string;
  tools: ToolContract[];
  withheld: WithheldTool[];
}

export function describeEnvironment(
  environment: ResolvedEnvironment,
  callable: readonly AgentDefinition[] = [],
): string {
  if (environment.kind === 'machine') {
    return describeMachine(environment.deviceName, environment.root);
  }
  if (environment.kind === 'sandbox') return describeWorkspace(environment.workspace, environment.worktree);

  const delegates = callable.some(needsWorkspace);
  const bases = environment.bases ?? [];

  return delegates && bases.length > 0
    ? [describeNoEnvironment(), describeForDelegation(bases)].join('\n\n')
    : describeNoEnvironment();
}

const ASKS: { tool: string; line: string }[] = [
  {
    tool: 'request_egress',
    line: 'If a host you need is blocked, call `request_egress` with the host, the port, and why you '
      + 'need it. Do not work around a blocked host by other means.',
  },
  {
    tool: 'request_secret',
    line: 'If you need a credential, call `request_secret`. Never guess one, and never read one out '
      + 'of the environment to put it somewhere else.',
  },
  {
    tool: 'propose_work',
    line: 'If the work is bigger than what you were asked for, call `propose_work` rather than doing '
      + 'it uninvited. Say what "done" means so anyone can check it.',
  },
];

function egressLine(environment: ResolvedEnvironment): string | undefined {
  const mode = environment.kind === 'none'
    ? undefined
    : environment.kind === 'machine'
      ? environment.egressMode
      : environment.workspace.egressMode;

  if (mode === 'auto') {
    return 'Outbound network is open in this environment. You still have to say what you are '
      + 'reaching for and why, in your own reasoning.';
  }
  if (mode === 'declared') {
    return 'Only the hosts named above are reachable. Anything else fails, and no retry changes that '
      + '— say so in your summary instead of trying again.';
  }
  return undefined;
}

export function describeAsks(environment: ResolvedEnvironment, tools: readonly ToolContract[]): string {
  const available = new Set(tools.map((tool) => tool.name));
  const egress = egressLine(environment);

  const lines = [
    ...ASKS.filter((ask) => available.has(ask.tool)).map((ask) => ask.line),
    ...(egress ? [egress] : []),
  ];

  if (lines.length === 0) return '';
  return ['WHEN YOU CANNOT PROCEED', '', ...lines.map((line) => `- ${line}`)].join('\n');
}

export function describeWithheld(withheld: readonly WithheldTool[]): string {
  if (withheld.length === 0) return '';
  return [
    'NOT AVAILABLE TO YOU THIS TURN',
    '',
    ...withheld.map((tool) => `- ${tool.name}: ${tool.why}`),
    '',
    'Do not call these and do not plan around them.',
  ].join('\n');
}

export function describeAvailable(tools: readonly ToolContract[]): string {
  if (tools.length === 0) return '';
  return [
    'TOOLS YOU CAN USE RIGHT NOW',
    '',
    ...tools.flatMap((tool) => {
      const guidance = tool.usageGuidance?.trim();
      const head = `- ${tool.name}: ${tool.description}`;
      return guidance ? [head, `  ${guidance}`] : [head];
    }),
  ].join('\n');
}

export function describeOutputs(agent: AgentDefinition): string {
  const outputs = agent.interface?.outputs ?? [];
  return outputs.length > 0 ? `When you are done, your answer must provide: ${outputs.join(', ')}.` : '';
}

export const joinSections = (sections: readonly string[]): string =>
  sections.filter((section) => section.length > 0).join('\n\n');

export interface ToolSetRequest {
  agent: AgentDefinition;
  callable?: readonly AgentDefinition[] | undefined;
  catalogue: readonly ToolContract[];
  capabilities: EnvironmentCapabilities;
  allowed?: 'granted' | 'none' | string[] | undefined;
}

export function resolveToolSet(request: ToolSetRequest): { tools: ToolContract[]; withheld: WithheldTool[] } {
  const delegates = agentTools(request.agent, request.callable ?? []);

  return effectiveTools({
    granted: [...request.agent.tools, ...delegates.map((tool) => tool.name)],
    catalogue: [...request.catalogue, ...delegates],
    capabilities: request.capabilities,
    ...(request.allowed ? { allowed: request.allowed } : {}),
  });
}
