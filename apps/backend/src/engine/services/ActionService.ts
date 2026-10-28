import { asPerson, type Principal } from '../../platform/index.js';
import type { ReleaseSettings } from '../../releases/index.js';
import type { ActionProposal } from '../lib/action-proposals.js';
import { DECIDABLE } from '../lib/action-proposals.js';
import { declareDependency, explainSpecProblems, validateSpec, visibleAppSpecs, type AppSpec } from '../../infrastructure/index.js';
import type { Database, PipelineRunMetadata, ProjectMetadata } from '../../platform/index.js';
import type { McpServerRecord } from '../lib/mcp-servers.js';
import type { ServerProposal } from '../lib/mcp-proposals.js';
import type { McpServerInput, McpServerOutcome } from './McpServerService.js';
import type { GrantMeta } from '../../engine-host/registries/agent-directory.js';
import type { ProposalProgress, ProposalStarted } from '@koala/harness-types';
import { serverProgress, type ImageNow } from '../../projects/index.js';
import type { TreeModelsService } from '../../models/index.js';
import { alertSpec, isAlertKind, type AlertSpec } from '../../monitoring/index.js';

export interface ActionServers {
  add(ownerId: string, input: McpServerInput & { template?: unknown }): Promise<McpServerOutcome>;
  list(ownerId: string): Promise<readonly McpServerRecord[]>;
}

export interface ActionAlerts {
  add(ownerId: string, deploymentId: string, spec: AlertSpec, conversationId?: string): Promise<{ summary: string }>;
  remove(ownerId: string, ruleId: string): Promise<void>;
}

export interface ActionAgents {
  agents(ownerId: string): Promise<readonly { slug: string; servers?: readonly string[] | undefined }[]>;
  holdServer(ownerId: string, slug: string, server: string, meta?: GrantMeta): Promise<ImageNow | undefined>;
  image(ownerId: string, slug: string): Promise<ImageNow | undefined>;
}

interface Executed {
  result: string;
  started?: ProposalStarted | undefined;
}

export type ActionStore = Pick<Database, 'engine' | 'projects' | 'releases' | 'infrastructure'>;

export interface ActionDeployer {
  deployApp(config: Record<string, unknown>, userId: string): Promise<{ id: string; resourceId?: string | undefined }>;
  promoteProjectBuild(project: ProjectMetadata, run: PipelineRunMetadata, userId: string): Promise<{ id: string; resourceId?: string | undefined }>;
}

export type ActionDecision =
  | { ok: true; proposal: ActionProposal }
  | { ok: false; status: 404 | 409; error: string };

export class ActionService {
  constructor(private readonly deps: {
    store: ActionStore;
    deployer: ActionDeployer;
    clusters?: { getById(id: string, principal: Principal, action: 'deploy-to'): Promise<unknown> } | undefined;
    servers?: ActionServers | undefined;
    dependencies?: Pick<import('./WorkspaceDependencyService.js').WorkspaceDependencyService, 'save'> | undefined;
    agents?: ActionAgents | undefined;
    releases?: Pick<ReleaseSettings, 'setForType' | 'setForProject'> | undefined;
    treeModels?: Pick<TreeModelsService, 'set'> | undefined;
    alerts?: ActionAlerts | undefined;
    now?: () => string;
    onSettled?: ((ownerId: string, conversationId: string | undefined) => void) | undefined;
  }) {}

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  list(ownerId: string, filter: { conversationId?: string | undefined; treeId?: string | undefined } = {}): Promise<ActionProposal[]> {
    return this.deps.store.engine.getActionProposals(ownerId, filter);
  }

  private async decidable(ownerId: string, id: string): Promise<{ found: ActionProposal } | ActionDecision> {
    const proposal = await this.deps.store.engine.getActionProposal(ownerId, id);
    if (!proposal) return { ok: false, status: 404, error: 'Proposal not found' };
    if (!DECIDABLE.includes(proposal.status)) return { ok: false, status: 409, error: `This proposal is already ${proposal.status}.` };
    return { found: proposal };
  }

  async apply(ownerId: string, id: string, principal?: Principal | undefined): Promise<ActionDecision> {
    const checked = await this.decidable(ownerId, id);
    if (!('found' in checked)) return checked;
    const proposal = checked.found;

    await this.deps.store.engine.saveActionProposal({ ...proposal, status: 'applying', updatedAt: this.now() });
    try {
      const { result, started } = await this.execute(ownerId, proposal, principal);
      const applied: ActionProposal = { ...proposal, status: 'applied', result, ...(started ? { started } : {}), updatedAt: this.now() };
      delete applied.reason;
      await this.deps.store.engine.saveActionProposal(applied);
      this.deps.onSettled?.(ownerId, proposal.conversationId);
      return { ok: true, proposal: applied };
    } catch (err) {
      const failed: ActionProposal = { ...proposal, status: 'failed', reason: (err as Error).message, updatedAt: this.now() };
      await this.deps.store.engine.saveActionProposal(failed);
      return { ok: true, proposal: failed };
    }
  }

  async reject(ownerId: string, id: string): Promise<ActionDecision> {
    const checked = await this.decidable(ownerId, id);
    if (!('found' in checked)) return checked;
    const rejected: ActionProposal = { ...checked.found, status: 'rejected', updatedAt: this.now() };
    await this.deps.store.engine.saveActionProposal(rejected);
    return { ok: true, proposal: rejected };
  }

  private async project(ownerId: string, projectId: string | undefined): Promise<ProjectMetadata> {
    const project = (await this.deps.store.projects.getProjects()).find((candidate) => candidate.id === projectId && candidate.ownerId === ownerId);
    if (!project) throw new Error('the project no longer exists');
    return project;
  }

  async progress(ownerId: string, id: string): Promise<ProposalProgress | undefined> {
    const proposal = await this.deps.store.engine.getActionProposal(ownerId, id);
    if (!proposal?.started || !this.deps.servers || !this.deps.agents) return undefined;
    const started = proposal.started;
    const server = started.server ? (await this.deps.servers.list(ownerId)).find((entry) => entry.id === started.server!.id) : undefined;
    const images = Object.fromEntries(await Promise.all((started.images ?? []).map(async (slug) => [slug, await this.deps.agents!.image(ownerId, slug)] as const)));
    return serverProgress(started, server, images);
  }

  private async addServer(ownerId: string, proposalId: string, spec: ServerProposal): Promise<Executed> {
    const { servers, agents } = this.deps;
    if (!servers || !agents) throw new Error('MCP servers cannot be added from here');
    const holders = await agents.agents(ownerId);
    const missing = spec.agents.filter((slug) => !holders.some((agent) => agent.slug === slug));
    if (missing.length > 0) throw new Error(`there is no agent called ${missing.join(', ')} any more`);

    let server = spec.server ? (await servers.list(ownerId)).find((candidate) => candidate.name === spec.server) : undefined;
    if (spec.server && !server) throw new Error(`there is no MCP server called ${spec.server} any more`);
    if (!server) {
      for (const dependency of spec.dependencies ?? []) {
        if (!this.deps.dependencies) throw new Error('dependencies cannot be added from here');
        const saved = await this.deps.dependencies.save(ownerId, dependency);
        if (!saved.saved) throw new Error(`the dependency ${dependency.name} could not be added: ${saved.problems.join('; ')}`);
      }
      const added = await servers.add(ownerId, {
        ...(spec.template ? { template: spec.template } : { runs: spec.runs }),
        name: spec.name, summary: spec.summary, notes: spec.notes, dependsOn: spec.dependsOn, offer: spec.offer, omit: spec.omit,
      });
      if (!added.ok) throw new Error(added.error);
      server = added.server;
    }

    const given: string[] = [];
    const building: string[] = [];
    for (const slug of spec.agents) {
      if ((holders.find((agent) => agent.slug === slug)?.servers ?? []).includes(server.name)) continue;
      const image = await agents.holdServer(ownerId, slug, server.name, { why: spec.why, proposalId });
      given.push(slug);
      if (image) building.push(slug);
    }
    const result = [
      ...(spec.server ? [] : [`added ${server.name}; its tools are being captured`]),
      ...(given.length ? [`given to ${given.join(', ')}${building.length ? `; building ${building.join(', ')}'s image${building.length === 1 ? '' : 's'}` : ''}`] : []),
    ].join('; ') || `${server.name} was already held by everyone named`;
    return { result, started: { server: { id: server.id, name: server.name, added: !spec.server }, ...(building.length ? { images: building } : {}) } };
  }

  private async execute(ownerId: string, proposal: ActionProposal, principal?: Principal | undefined): Promise<Executed> {
    if (proposal.kind === 'add_mcp_server') return this.addServer(ownerId, proposal.id, JSON.parse(proposal.params.spec ?? '{}') as ServerProposal);
    return { result: await this.carryOut(ownerId, proposal, principal) };
  }

  private async carryOut(ownerId: string, proposal: ActionProposal, principal?: Principal | undefined): Promise<string> {
    const { params } = proposal;
    switch (proposal.kind) {
      case 'deploy_app': {
        if (this.deps.clusters && !(await this.deps.clusters.getById(params.clusterId ?? '', principal ?? asPerson(ownerId), 'deploy-to'))) throw new Error('that cluster is not one you can deploy to');
        const deal = await this.deps.deployer.deployApp({
          appType: params.appType, name: params.name, clusterId: params.clusterId, strategy: params.strategy ?? 'native',
        }, ownerId);
        return `deploying ${params.name} (workflow ${deal.id})`;
      }
      case 'deploy_project': {
        const project = await this.project(ownerId, params.projectId);
        const run = (await this.deps.store.releases.getPipelineRuns()).find((candidate) => candidate.id === params.runId && candidate.projectId === project.id);
        if (!run) throw new Error('that build no longer exists');
        const deal = await this.deps.deployer.promoteProjectBuild(project, run, ownerId);
        return `deploying ${project.name} from build ${run.id} (workflow ${deal.id})`;
      }
      case 'set_project_env': {
        const project = await this.project(ownerId, params.projectId);
        await this.deps.store.projects.saveProject({ ...project, deployEnv: params.env ?? '', updatedAt: this.now() } as ProjectMetadata);
        return `${project.name}'s environment is set; it takes effect on the next deploy`;
      }
      case 'add_app_spec': {
        const spec = JSON.parse(params.spec ?? '{}') as AppSpec;
        const problems = validateSpec(spec);
        if (problems.length) throw new Error(explainSpecProblems(problems));
        const existing = visibleAppSpecs(await this.deps.store.infrastructure.getAppSpecs(), ownerId).find((entry) => entry.id === spec.id);
        if (existing?.builtIn) throw new Error(`"${spec.id}" ships with the platform and cannot be replaced`);
        const stamp = this.now();
        await this.deps.store.infrastructure.saveAppSpec({ id: spec.id, spec, builtIn: false, ownerId, createdAt: existing?.createdAt ?? stamp, updatedAt: stamp });
        return `"${spec.id}" is in your catalogue and can be deployed`;
      }
      case 'add_mcp_server':
        throw new Error('an MCP server is added by addServer');
      case 'set_release': {
        if (!this.deps.releases) throw new Error('release settings cannot be changed here');
        const how = params.clear === 'true' ? undefined : { agent: params.agent ?? '', ...(params.app ? { app: params.app } : {}) };
        const target = params.id ?? '';
        const outcome = params.target === 'treeType'
          ? await this.deps.releases.setForType(ownerId, target, how)
          : await this.deps.releases.setForProject(ownerId, target, how);
        if (!outcome.ok) throw new Error(outcome.error);
        return how ? `builds are released by the ${how.agent} agent${how.app ? ` with the ${how.app} adapter` : ''} from the next build` : 'the setting is cleared; the next build is released the default way';
      }
      case 'set_tree_model': {
        if (!this.deps.treeModels) throw new Error('a tree\'s models cannot be changed here');
        const outcome = await this.deps.treeModels.set(ownerId, params.treeId ?? '', { agent: params.agent, modelId: params.clear === 'true' ? null : params.modelId });
        if (!outcome.ok) throw new Error(outcome.error);
        return params.clear === 'true' ? `${params.agent} is back on its own model in this tree` : `${params.agent} works on ${params.modelId} in this tree from its next run`;
      }
      case 'set_alert': {
        if (!this.deps.alerts) throw new Error('alerts cannot be set here');
        if (params.remove) {
          await this.deps.alerts.remove(ownerId, params.remove);
          return 'the alert is removed';
        }
        if (!isAlertKind(params.kind)) throw new Error(`there is no alert of kind ${params.kind}`);
        const spec = alertSpec(params.kind, params.threshold ? Number(params.threshold) : undefined, params.forMinutes ? Number(params.forMinutes) : undefined);
        if ('error' in spec) throw new Error(spec.error);
        const rule = await this.deps.alerts.add(ownerId, params.deploymentId ?? '', spec, proposal.conversationId);
        return `set: ${rule.summary}`;
      }
      case 'add_project_dependency': {
        const out = await declareDependency(this.deps.store, ownerId, { projectId: params.projectId, service: params.service, as: params.as });
        if (out.error) throw new Error(out.error);
        return out.added ? `${out.added.service} is mounted at ${out.readAt} from the next deploy` : (out.note ?? 'nothing to change');
      }
    }
  }
}
