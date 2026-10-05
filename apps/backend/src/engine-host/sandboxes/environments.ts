import {
  environmentFor,
  needsWorkspace,
  type AgentDefinition,
  type EgressMode,
  allowAll,
  type ApprovalGate,
  BASES,
  planFor,
  type ToolDefinition,
} from '@koala/agent-engine';
import { createNoneDriver } from '@koala/engine-core';
import { createMachineDriver, type MachineBackend } from '../drivers/machine.js';
import { environmentIdFor, type RunEnvironments } from './run-environments.js';
import {
  DEFAULT_CPU, DEFAULT_MEMORY, EGRESS_PROXY, egressFor, lifetimeFor, packageAccessFor,
  type EgressRule, type RunWorkspace,
} from './workspace.js';
import type { ImageBuilder } from './image-builder.js';
import type { EnvironmentDriver, EnvironmentSpec } from '@koala/engine-core';
import type { EnvironmentHandleRef, RunEnvironment, RunTicket } from '../temporal/contracts.js';
import type { AgentRegistry } from '../registries/registry.js';

export type WorkspaceTarget =
  | { kind: 'machine'; deviceId: string; deviceName: string; path?: string | undefined }
  | { kind: 'sandbox'; spec?: Partial<EnvironmentSpec> | undefined };

export interface WorkspaceSource {
  forRun(ticket: RunTicket): Promise<WorkspaceTarget | undefined>;
}

export interface EnvironmentRequest {
  ticket: RunTicket;
  environment?: EnvironmentHandleRef | undefined;
  worktree?: string | undefined;
}

export interface EnvironmentResolver {
  describe(ticket: RunTicket, wallClockLimitMs?: number | undefined): Promise<RunEnvironment>;
  describeShared(request: { ticket: RunTicket; agents: readonly string[] }): Promise<Extract<RunEnvironment, { kind: 'sandbox' }>>;
  forRun(request: EnvironmentRequest): Promise<EnvironmentDriver | undefined>;
  release(runId: string): Promise<void>;
}

export interface EnvironmentResolverOptions {
  registry: AgentRegistry;
  environments: RunEnvironments;
  images: ImageBuilder;
  tools: (ownerId: string) => Promise<ToolDefinition[]>;
  workspaces?: WorkspaceSource | undefined;
  machineBackend?: MachineBackend | undefined;
  approval?: ApprovalGate | undefined;
  egress?: {
    grants(ownerId: string, agentSlug: string): Promise<{ host: string; ports?: number[] | undefined }[]>;
    proxyUrl(ownerId: string, agentSlug: string): string;
  } | undefined;
}

export class NoMachineAvailableError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'NoMachineAvailableError';
  }
}

export async function workspaceFor(input: {
  runId: string;
  ownerId: string;
  agent: AgentDefinition;
  tools: readonly ToolDefinition[];
  images: ImageBuilder;
  egressMode: EgressMode;
  wallClockLimitMs?: number | undefined;
  grants?: readonly { host: string; ports?: readonly number[] | undefined }[] | undefined;
  proxyUrl?: string | undefined;
}): Promise<RunWorkspace> {
  const plan = planFor(input.agent, input.tools);
  if (!plan) throw new Error(`${input.agent.slug} does not run in a sandbox, so it has no workspace image`);

  const reference = await input.images.ensure(plan);
  const access = packageAccessFor(plan.provides);

  const granted = input.egressMode === 'none' || input.egressMode === 'auto' || !input.proxyUrl ? [] : [...(input.grants ?? [])];
  const credentialed = granted.length > 0
    ? [{ name: 'HTTPS_PROXY', value: input.proxyUrl! }, { name: 'https_proxy', value: input.proxyUrl! }]
    : [];
  const env = [...access.env.filter((entry) => !credentialed.some((over) => over.name === entry.name)), ...credentialed];

  return {
    runId: input.runId,
    ownerId: input.ownerId,
    agent: input.agent.slug,
    image: reference,
    provides: plan.provides,
    egressMode: input.egressMode,
    lifetimeMs: lifetimeFor(input.wallClockLimitMs),
    cpu: DEFAULT_CPU,
    memory: DEFAULT_MEMORY,
    egress: egressFor(input.egressMode, access, granted.length > 0 ? [EGRESS_PROXY] : []),
    env,
    ...(granted.length > 0 ? { grantedHosts: granted.map((grant) => `${grant.host}${grant.ports?.length ? `:${grant.ports.join(',')}` : ''}`) } : {}),
  };
}

/**
 * The one workspace a grove tree works in: the union of what its agents need. Shared with the image
 * pruner, which has to know this fingerprint is wanted or it would delete the image every tree runs
 * in, and each run would rebuild it.
 */
export class NothingToShareError extends Error {
  constructor(agents: readonly string[]) {
    super(`none of ${agents.join(', ')} works in a sandbox, so there is nothing to share`);
    this.name = 'NothingToShareError';
  }
}

export function mergeWorkspaceAgents(
  agents: readonly (AgentDefinition | undefined)[],
  slug: string,
): AgentDefinition | undefined {
  const working = agents.filter((agent): agent is AgentDefinition => agent !== undefined && environmentFor(agent).kind === 'sandbox');
  const [first] = working;
  if (!first) return undefined;

  const unique = (values: string[]): string[] => [...new Set(values)];

  return {
    ...first,
    slug,
    tools: unique(working.flatMap((agent) => agent.tools)),
    environment: {
      ...Object.assign({}, ...working.map((agent) => agent.environment)),
      languages: unique(working.flatMap((agent) => agent.environmentSpec?.languages ?? agent.environment.languages ?? [])),
    },
  };
}

export function createEnvironmentResolver(options: EnvironmentResolverOptions): EnvironmentResolver {
  const approval = options.approval ?? allowAll();
  const egressFor_ = async (ownerId: string, agentSlug: string) => (options.egress
    ? { grants: await options.egress.grants(ownerId, agentSlug), proxyUrl: options.egress.proxyUrl(ownerId, agentSlug) }
    : {});

  const specFor = async (ticket: RunTicket): Promise<
    { agent: AgentDefinition; spec: EnvironmentSpec; workspace: boolean } | undefined
  > => {
    const agent = await options.registry.agent(ticket.ownerId, ticket.agentSlug);
    if (!agent) return undefined;
    return { agent, spec: environmentFor(agent), workspace: needsWorkspace(agent) };
  };

  return {
    async describeShared({ ticket, agents }) {
      const found = await Promise.all(agents.map((slug) => options.registry.agent(ticket.ownerId, slug)));
      const merged = mergeWorkspaceAgents(found, ticket.agentSlug);
      if (!merged) throw new NothingToShareError(agents);

      const workspace = await workspaceFor({
        runId: ticket.runId,
        ownerId: ticket.ownerId,
        agent: merged,
        tools: await options.tools(ticket.ownerId),
        images: options.images,
        egressMode: merged.egressMode ?? 'declared',
        ...(await egressFor_(ticket.ownerId, merged.slug)),
      });

      return {
        kind: 'sandbox',
        id: environmentIdFor(ticket.runId),
        capabilities: { ...environmentFor(merged), lifecycle: 'persistent' },
        workspace: { ...workspace, persistent: true },
      };
    },

    async describe(ticket: RunTicket, wallClockLimitMs?: number | undefined): Promise<RunEnvironment> {
      const resolved = await specFor(ticket);
      if (!resolved) return { kind: 'none', egress: false };

      const { agent, spec, workspace } = resolved;
      const egressMode = agent.egressMode ?? 'declared';

      if (spec.kind === 'none') {
        return { kind: 'none', egress: spec.egress === true, bases: BASES.map((base: { id: string }) => base.id) };
      }

      const target = workspace ? await options.workspaces?.forRun(ticket) : undefined;

      if (target?.kind === 'machine') {
        return {
          kind: 'machine',
          deviceId: target.deviceId,
          deviceName: target.deviceName,
          ...(target.path ? { path: target.path } : {}),
          egressMode,
        };
      }

      const merged: EnvironmentSpec = { ...spec, ...(target?.spec ?? {}) };

      return {
        kind: 'sandbox',
        id: environmentIdFor(ticket.runId),
        capabilities: merged,
        workspace: await workspaceFor({
          runId: ticket.runId,
          ownerId: ticket.ownerId,
          agent,
          tools: await options.tools(ticket.ownerId),
          images: options.images,
          egressMode,
          wallClockLimitMs,
          ...(await egressFor_(ticket.ownerId, agent.slug)),
        }),
      };
    },

    async forRun(request: EnvironmentRequest): Promise<EnvironmentDriver | undefined> {
      const { ticket, environment } = request;

      if (environment?.scope?.deviceId) {
        if (!options.machineBackend) {
          throw new NoMachineAvailableError(
            `${ticket.agentSlug} needs to work on your machine, but this server cannot reach local machines.`,
          );
        }

        const resolved = await specFor(ticket);

        return createMachineDriver({
          deviceId: environment.scope.deviceId,
          ownerId: ticket.ownerId,
          runId: ticket.runId,
          agentSlug: ticket.agentSlug,
          scope: {
            ...(environment.scope.path ? { path: environment.scope.path } : {}),
            ...(request.worktree ?? environment.scope.worktree
              ? { worktree: (request.worktree ?? environment.scope.worktree)! }
              : {}),
          },
          ...(resolved?.spec.languages ? { languages: resolved.spec.languages } : {}),
          backend: options.machineBackend,
          approval,
        });
      }

      const spec = environment?.spec ?? (await specFor(ticket))?.spec;
      if (!spec) return undefined;

      if (spec.kind === 'none') {
        return createNoneDriver({
          id: `none:${ticket.runId}`,
          ...(spec.egress ? { egress: true } : {}),
        });
      }

      return options.environments.forRun({
        ticket,
        ...(environment?.id ? { id: environment.id } : {}),
        spec,
        ...(environment?.workspace ? { workspace: environment.workspace } : {}),
        ...(request.worktree ?? environment?.scope?.worktree ? { scope: { worktree: (request.worktree ?? environment?.scope?.worktree)! } } : {}),
      });
    },

    async release(runId: string): Promise<void> {
      await options.environments.release(runId);
    },
  };
}
