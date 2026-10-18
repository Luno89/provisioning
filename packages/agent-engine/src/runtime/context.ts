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
  type ServedBy,
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
  self?: { agent: string; runId: string },
): string {
  if (environment.kind === 'machine') {
    return describeMachine(environment.deviceName, environment.root);
  }
  if (environment.kind === 'sandbox') return describeWorkspace(environment.workspace, environment.worktree, self);

  const delegates = callable.some(needsWorkspace);
  const bases = environment.bases ?? [];

  return delegates && bases.length > 0
    ? [describeNoEnvironment(), describeForDelegation(bases)].join('\n\n')
    : describeNoEnvironment();
}

export const RUN_IN_WORKSPACE_NAME = 'run_in_workspace';

export const RUN_IN_WORKSPACE_DESCRIPTION = 'Runs a shell command in the project\'s workspace, where its checks, its database and the app\'s own tools are, after bringing your work so far there: everything in your folder, committed or not. Use it to run tests, checks or the app itself; your own folder has none of them. It returns what the command printed and its exit code.';

export function describeOnMachine(environment: ResolvedEnvironment): string {
  if (environment.kind === 'sandbox') {
    const folder = environment.worktree ? `the folder ${environment.worktree} of the project's repository` : 'the project\'s repository';
    return [
      'HOW YOU WORK HERE',
      '',
      'You are an agent on the person\'s own machine, doing one step of Koala\'s work for them. Koala runs the project and the procedure around you; you do this step.',
      `- The folder you were told to work in is a checkout of ${folder}, from the project's workspace in Koala, at the same commit. Edit it with your own tools, and commit when you like.`,
      `- Everything the project runs on is in that workspace, not on this machine: its image, languages and tools, its services, its database and its checks. Do not look for them here, install them or start copies of your own. Run them with ${RUN_IN_WORKSPACE_NAME}: it takes everything in your folder there first, committed or not, and runs the command from the same place in the project.`,
      `- The execution environment described next is that workspace, written as it is told to an agent working inside it. For you, a command it describes is one you run with ${RUN_IN_WORKSPACE_NAME}, and the working directory it names is the same place in the project as your folder.`,
      '- When your turn ends, everything in your folder goes back into the workspace, committed or not. Nothing you leave outside the folder reaches Koala.',
      '- Koala\'s own tools are served to you through the MCP server named koala: the ones listed under the tools you can use. Call them there, not by doing their work another way.',
    ].join('\n');
  }
  if (environment.kind === 'machine') {
    return [
      'HOW YOU WORK HERE',
      '',
      'You are an agent on the person\'s own machine, doing one step of Koala\'s work for them, in the folder you were told to work in.',
      '- That folder is the project\'s own folder on this machine; what you change there stays there.',
      '- Koala\'s own tools are served to you through the MCP server named koala: the ones listed under the tools you can use. Call them there, not by doing their work another way.',
    ].join('\n');
  }
  return '';
}

export function describeOwnOnMachine(own: readonly ToolContract[], workspace: boolean): string {
  if (own.length === 0) return '';
  return [
    'YOURS ON THIS MACHINE',
    '',
    `Koala would give a model these tools: ${own.map((tool) => tool.name).join(', ')}. You have your own for the same work, so use yours, in your folder.${workspace ? ` To run something where the project runs, use ${RUN_IN_WORKSPACE_NAME}.` : ''}`,
  ].join('\n');
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

const toolLines = (tool: ToolContract, indent = ''): string[] => {
  const guidance = tool.usageGuidance?.trim();
  return [
    `${indent}- ${tool.name}: ${tool.description}`,
    ...(guidance ? [`${indent}  ${guidance}`] : []),
    ...(tool.learned ?? []).map((note) => `${indent}  Learned from earlier runs: ${note}`),
    ...(tool.openWorld ? [`${indent}  What it returns comes from outside this platform and can differ from one call to the next.`] : []),
  ];
};

const serverLines = (served: ServedBy): string[] => {
  const where = served.where === 'workspace' ? 'an MCP server that runs in your workspace' : 'an MCP server this platform reaches for you';
  const said = [
    ...(served.instructions?.trim() ? [`What the server says about itself: ${served.instructions.trim()}`] : []),
    ...(served.notes?.trim() ? [`The person's notes: ${served.notes.trim()}`] : []),
    ...(served.dependsOn?.trim() ? [`It depends on: ${served.dependsOn.trim()}`] : []),
    ...(served.learned ?? []).map((note) => `Learned from earlier runs: ${note}`),
  ];
  return [`- From ${served.server}, ${where}${served.summary?.trim() ? `: ${served.summary.trim()}` : ''}`, ...said.map((line) => `  ${line}`)];
};

export function describeAvailable(tools: readonly ToolContract[]): string {
  if (tools.length === 0) return '';
  const servers = new Map<string, { served: ServedBy; tools: ToolContract[] }>();
  for (const tool of tools) {
    if (!tool.servedBy) continue;
    const group = servers.get(tool.servedBy.server) ?? { served: tool.servedBy, tools: [] };
    group.tools.push(tool);
    servers.set(tool.servedBy.server, group);
  }
  return [
    'TOOLS YOU CAN USE RIGHT NOW',
    '',
    ...tools.filter((tool) => !tool.servedBy).flatMap((tool) => toolLines(tool)),
    ...[...servers.values()].flatMap((group) => [
      ...serverLines(group.served),
      ...group.tools.flatMap((tool) => toolLines(tool, '  ')),
    ]),
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
    ...(request.agent.maxEffect ? { ceiling: request.agent.maxEffect } : {}),
  });
}
