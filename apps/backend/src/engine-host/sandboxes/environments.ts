import {
  environmentFor,
  needsWorkspace,
  activeGrants,
  type AgentDefinition,
  type EgressMode,
  type EgressGrant,
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
  DEFAULT_CPU, DEFAULT_MEMORY, egressFor, lifetimeFor, packageAccessFor,
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
}): Promise<RunWorkspace> {
  const plan = planFor(input.agent, input.tools);
  if (!plan) throw new Error(`${input.agent.slug} does not run in a sandbox, so it has no workspace image`);

  const reference = await input.images.ensure(plan);
  const access = packageAccessFor(plan.provides);

  const hosts = activeGrants(input.agent).map((grant: EgressGrant) => ({
    cidr: '0.0.0.0/0',
    ...(grant.ports?.length ? { ports: grant.ports } : {}),
  } as EgressRule));

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
    egress: egressFor(input.egressMode, access, input.egressMode === 'auto' ? [] : hosts),
    env: access.env,
  };
}

export function createEnvironmentResolver(options: EnvironmentResolverOptions): EnvironmentResolver {
  const approval = options.approval ?? allowAll();

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
      const working = found.filter((agent): agent is AgentDefinition => agent !== undefined && environmentFor(agent).kind === 'sandbox');
      const [first] = working;
      if (!first) throw new Error(`none of ${agents.join(', ')} works in a sandbox, so there is nothing to share`);

      const unique = (values: string[]): string[] => [...new Set(values)];
      const merged: AgentDefinition = {
        ...first,
        slug: ticket.agentSlug,
        tools: unique(working.flatMap((agent) => agent.tools)),
        environment: {
          ...Object.assign({}, ...working.map((agent) => agent.environment)),
          languages: unique(working.flatMap((agent) => agent.environmentSpec?.languages ?? agent.environment.languages ?? [])),
        },
      };

      const workspace = await workspaceFor({
        runId: ticket.runId,
        ownerId: ticket.ownerId,
        agent: merged,
        tools: await options.tools(ticket.ownerId),
        images: options.images,
        egressMode: merged.egressMode ?? 'declared',
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
        ...(request.worktree ? { scope: { worktree: request.worktree } } : {}),
      });
    },

    async release(runId: string): Promise<void> {
      await options.environments.release(runId);
    },
  };
}
