import {
  BYPASS_ENV,
  environmentFor,
  needsWorkspace,
  type AgentDefinition,
  type EgressMode,
  allowAll,
  type ApprovalGate,
  BASES,
  planFor,
  type ImagePlan,
  type ToolDefinition,
  type WorkspaceDependency,
} from '@koala/agent-engine';
import { machineChoice } from '@koala/agent-engine/procedure';
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
import { composeWithBases } from '../../extensions/workspace-bases.js';
import type { McpServerRecord } from '../../lib/mcp-servers.js';
import type { ComposedWorkspace } from '../../lib/workspace-composition.js';
import { readWorkspaceFile, type WorkspaceFile, pendingChanges } from '../../lib/workspace-file.js';
import { stageText, type PublishedWorkspace } from '../../lib/published-workspace.js';
import { repositoryOf, treeOfWorkspace } from './workspace-repos.js';

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
  describeShared(request: { ticket: RunTicket; agents: readonly string[]; languages?: readonly string[] | undefined; extras?: WorkspaceExtras | undefined; treeId?: string | undefined }): Promise<Extract<RunEnvironment, { kind: 'sandbox' }>>;
  composeShared(request: { ticket: RunTicket; agents: readonly string[]; languages?: readonly string[] | undefined; file?: WorkspaceFile | undefined }): Promise<ComposedWorkspace>;
  forRun(request: EnvironmentRequest): Promise<EnvironmentDriver | undefined>;
  release(runId: string): Promise<void>;
}

export interface WorkspaceExtras {
  env?: readonly { name: string; value: string }[] | undefined;
  egress?: readonly EgressRule[] | undefined;
}

export function withExtras(workspace: RunWorkspace, extras: WorkspaceExtras | undefined): RunWorkspace {
  if (!extras) return workspace;
  const taken = new Set(workspace.env.map((entry) => entry.name));
  const env = [...workspace.env, ...(extras.env ?? []).filter((entry) => !taken.has(entry.name))];
  const key = (rule: EgressRule) => `${rule.namespace ?? rule.cidr}:${(rule.ports ?? []).join(',')}`;
  const seen = new Set(workspace.egress.map(key));
  const egress = [...workspace.egress, ...(extras.egress ?? []).filter((rule) => !seen.has(key(rule)) && seen.add(key(rule)))];
  return { ...workspace, env, egress };
}

export interface EnvironmentResolverOptions {
  registry: AgentRegistry;
  environments: RunEnvironments;
  images: ImageBuilder;
  tools: (ownerId: string) => Promise<ToolDefinition[]>;
  servers?: ((ownerId: string) => Promise<readonly McpServerRecord[]>) | undefined;
  dependencies?: ((ownerId: string) => Promise<readonly WorkspaceDependency[]>) | undefined;
  workspaces?: WorkspaceSource | undefined;
  machineBackend?: MachineBackend | undefined;
  approval?: ApprovalGate | undefined;
  egress?: {
    grants(ownerId: string, agentSlug: string): Promise<{ host: string; ports?: number[] | undefined }[]>;
    proxyUrl(ownerId: string, agentSlug: string): string;
  } | undefined;
  published?: PublishedWorkspaces | undefined;
  now?: (() => string) | undefined;
}

export interface PublishedWorkspaces {
  get(ownerId: string, treeId: string): Promise<PublishedWorkspace | undefined>;
  save(workspace: PublishedWorkspace): Promise<void>;
  file(ownerId: string, treeId: string): Promise<string | undefined>;
  describe(ownerId: string, treeId: string): Promise<Extract<RunEnvironment, { kind: 'sandbox' }>>;
}

export class NoMachineAvailableError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'NoMachineAvailableError';
  }
}

export interface ComposedRunWorkspace {
  workspace: RunWorkspace;
  plan?: ImagePlan | undefined;
  fileEnv: { name: string; value: string }[];
}

export async function workspaceFor(input: Parameters<typeof composeRunWorkspace>[0]): Promise<RunWorkspace> {
  return (await composeRunWorkspace(input)).workspace;
}

export async function composeRunWorkspace(input: {
  runId: string;
  ownerId: string;
  agent: AgentDefinition;
  tools: readonly ToolDefinition[];
  images: ImageBuilder;
  egressMode: EgressMode;
  wallClockLimitMs?: number | undefined;
  grants?: readonly { host: string; ports?: readonly number[] | undefined }[] | undefined;
  proxyUrl?: string | undefined;
  file?: WorkspaceFile | undefined;
  published?: PublishedWorkspace | undefined;
  servers?: readonly McpServerRecord[] | undefined;
  dependencies?: readonly WorkspaceDependency[] | undefined;
}): Promise<ComposedRunWorkspace> {
  const composed = input.published ? undefined : composeWithBases(input.agent, input.tools, input.file, input.servers, input.dependencies);
  if (!input.published && !composed) throw new Error(`${input.agent.slug} does not run in a sandbox, so it has no workspace image`);
  const plan = composed?.plan;
  const fileEnv = input.published ? input.published.env : composed!.env;
  const provides = input.published ? input.published.provides : plan!.provides;
  const planEnv = input.published ? input.published.baseEnv : (plan!.env ?? []);

  const reference = input.published ? input.published.image : await input.images.ensure(plan!);
  const access = packageAccessFor(provides);

  const granted = input.egressMode === 'none' || input.egressMode === 'auto' || !input.proxyUrl ? [] : [...(input.grants ?? [])];
  const credentialed = granted.length > 0
    ? [{ name: 'HTTPS_PROXY', value: input.proxyUrl! }, { name: 'https_proxy', value: input.proxyUrl! }, ...BYPASS_ENV]
    : [];
  const baseEnv = planEnv.filter((entry) => !access.env.some((own) => own.name === entry.name));
  const declared = fileEnv.filter((entry) => !access.env.some((own) => own.name === entry.name) && !baseEnv.some((own) => own.name === entry.name));
  const env = [...access.env, ...baseEnv, ...declared].filter((entry) => !credentialed.some((over) => over.name === entry.name)).concat(credentialed);

  const workspace: RunWorkspace = {
    runId: input.runId,
    ownerId: input.ownerId,
    agent: input.agent.slug,
    image: reference,
    provides,
    egressMode: input.egressMode,
    ...(lifetimeFor(input.wallClockLimitMs) ? { lifetimeMs: lifetimeFor(input.wallClockLimitMs) } : {}),
    cpu: DEFAULT_CPU,
    memory: DEFAULT_MEMORY,
    egress: egressFor(input.egressMode, access, granted.length > 0 ? [EGRESS_PROXY] : []),
    env,
    ...(granted.length > 0 ? { grantedHosts: granted.map((grant) => `${grant.host}${grant.ports?.length ? `:${grant.ports.join(',')}` : ''}`) } : {}),
  };
  return { workspace, ...(plan ? { plan } : {}), fileEnv };
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
  languages: readonly string[] = [],
): AgentDefinition | undefined {
  const working = agents.filter((agent): agent is AgentDefinition => agent !== undefined && environmentFor(agent).kind === 'sandbox');
  const [first] = working;
  if (!first) return undefined;

  const unique = (values: string[]): string[] => [...new Set(values)];
  const merged = unique([...languages, ...working.flatMap((agent) => agent.environmentSpec?.languages ?? agent.environment.languages ?? [])]);

  return {
    ...first,
    slug,
    tools: unique(working.flatMap((agent) => agent.tools)),
    servers: unique(working.flatMap((agent) => agent.servers ?? [])),
    needs: unique(working.flatMap((agent) => agent.needs ?? [])),
    environment: {
      ...Object.assign({}, ...working.map((agent) => agent.environment)),
      languages: merged,
    },
    ...(first.environmentSpec ? { environmentSpec: { ...first.environmentSpec, languages: merged } } : {}),
  };
}

export function createEnvironmentResolver(options: EnvironmentResolverOptions): EnvironmentResolver {
  const serversOf = async (ownerId: string): Promise<readonly McpServerRecord[]> => (options.servers ? options.servers(ownerId) : []);
  const dependenciesOf = async (ownerId: string): Promise<readonly WorkspaceDependency[] | undefined> => (options.dependencies ? options.dependencies(ownerId) : undefined);
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

  const currentWorkspace = async (ownerId: string, workspace: RunWorkspace | undefined): Promise<RunWorkspace | undefined> => {
    const treeId = workspace?.persistent ? treeOfWorkspace(workspace.runId) : undefined;
    if (!workspace || !treeId || !options.published) return workspace;
    const published = await options.published.get(ownerId, treeId);
    if (!published || published.image === workspace.image) return workspace;
    return (await options.published.describe(ownerId, treeId)).workspace ?? workspace;
  };

  return {
    async composeShared({ ticket, agents, languages, file }) {
      const found = await Promise.all(agents.map((slug) => options.registry.agent(ticket.ownerId, slug)));
      const merged = mergeWorkspaceAgents(found, ticket.agentSlug, languages);
      if (!merged) throw new NothingToShareError(agents);
      const composed = composeWithBases(merged, await options.tools(ticket.ownerId), file, await serversOf(ticket.ownerId), await dependenciesOf(ticket.ownerId));
      if (!composed) throw new NothingToShareError(agents);
      return composed;
    },

    async describeShared({ ticket, agents, languages, extras, treeId }) {
      const found = await Promise.all(agents.map((slug) => options.registry.agent(ticket.ownerId, slug)));
      const merged = mergeWorkspaceAgents(found, ticket.agentSlug, languages);
      if (!merged) throw new NothingToShareError(agents);

      const store = treeId ? options.published : undefined;
      const tools = await options.tools(ticket.ownerId);
      const servers = await serversOf(ticket.ownerId);
      const dependencies = await dependenciesOf(ticket.ownerId);
      const published = store ? await store.get(ticket.ownerId, treeId!) : undefined;
      const read = store && !published ? readWorkspaceFile(await store.file(ticket.ownerId, treeId!).catch(() => undefined)) : undefined;
      const file = published ? published.file : read && 'file' in read ? read.file : undefined;
      const current = published && composeWithBases(merged, tools, file, servers, dependencies)?.plan.fingerprint === published.fingerprint ? published : undefined;
      const onMain = published ? readWorkspaceFile(await store!.file(ticket.ownerId, treeId!).catch(() => undefined)) : undefined;
      const coming = published && onMain && 'file' in onMain ? pendingChanges(published.file, onMain.file) : [];
      const { workspace, plan, fileEnv } = await composeRunWorkspace({
        runId: ticket.runId,
        ownerId: ticket.ownerId,
        agent: merged,
        tools,
        servers,
        ...(dependencies ? { dependencies } : {}),
        images: options.images,
        egressMode: merged.egressMode ?? 'declared',
        ...(file ? { file } : {}),
        ...(current ? { published: current } : {}),
        ...(await egressFor_(ticket.ownerId, merged.slug)),
      });
      if (store && plan) {
        await store.save({
          ownerId: ticket.ownerId,
          treeId: treeId!,
          ...(published?.commit ? { commit: published.commit } : {}),
          file: file ?? {},
          fingerprint: plan.fingerprint,
          image: workspace.image,
          provides: plan.provides,
          lines: plan.lines ?? [],
          env: fileEnv,
          baseEnv: plan.env ?? [],
          publishedAt: (options.now ?? (() => new Date().toISOString()))(),
        });
      }

      const repository = repositoryOf(ticket.runId);
      return {
        kind: 'sandbox',
        id: environmentIdFor(ticket.runId),
        capabilities: { ...environmentFor(merged), lifecycle: 'persistent' },
        workspace: { ...withExtras(workspace, extras), persistent: true, ...(repository ? { repository } : {}), ...(coming.length ? { coming: { what: coming, stage: stageText(published?.next) } } : {}) },
      };
    },

    async describe(ticket: RunTicket, wallClockLimitMs?: number | undefined): Promise<RunEnvironment> {
      const resolved = await specFor(ticket);
      if (!resolved) return { kind: 'none', egress: false };

      const { agent, spec, workspace } = resolved;
      const egressMode = agent.egressMode ?? 'declared';

      if (machineChoice(ticket.modelId) && !ticket.inPlace) {
        const chosen = await options.workspaces?.forRun(ticket);
        if (chosen?.kind !== 'machine') throw new NoMachineAvailableError(`${ticket.agentSlug} was sent to a machine that is not one of yours any more`);
        return { kind: 'machine', deviceId: chosen.deviceId, deviceName: chosen.deviceName, ...(chosen.path ? { path: chosen.path } : {}), egressMode };
      }

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
          servers: await serversOf(ticket.ownerId),
          ...(await dependenciesOf(ticket.ownerId).then((dependencies) => (dependencies ? { dependencies } : {}))),
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

      const workspace = await currentWorkspace(ticket.ownerId, environment?.workspace);
      return options.environments.forRun({
        ticket,
        ...(environment?.id ? { id: environment.id } : {}),
        spec,
        ...(workspace ? { workspace } : {}),
        ...(request.worktree ?? environment?.scope?.worktree ? { scope: { worktree: (request.worktree ?? environment?.scope?.worktree)! } } : {}),
      });
    },

    async release(runId: string): Promise<void> {
      await options.environments.release(runId);
    },
  };
}
