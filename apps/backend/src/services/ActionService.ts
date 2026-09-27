import type { ActionProposal } from '../lib/action-proposals.js';
import { DECIDABLE } from '../lib/action-proposals.js';
import { declareDependency } from '../lib/declare-dependency.js';
import type { Database } from '../lib/db-interface.js';
import type { PipelineRunMetadata, ProjectMetadata } from '../lib/types.js';

export type ActionStore = Pick<Database,
  'getActionProposals' | 'getActionProposal' | 'saveActionProposal'
  | 'getProjects' | 'saveProject' | 'getPipelineRuns' | 'getDeployments' | 'getAppSpecs' | 'getBindingTypes'>;

export interface ActionDeployer {
  deployApp(config: Record<string, unknown>, userId: string): Promise<{ id: string; resourceId?: string | undefined }>;
  promoteProjectBuild(project: ProjectMetadata, run: PipelineRunMetadata, userId: string): Promise<{ id: string; resourceId?: string | undefined }>;
}

export type ActionDecision =
  | { ok: true; proposal: ActionProposal }
  | { ok: false; status: 404 | 409; error: string };

export class ActionService {
  constructor(private readonly deps: { store: ActionStore; deployer: ActionDeployer; now?: () => string }) {}

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  list(ownerId: string, filter: { conversationId?: string | undefined; treeId?: string | undefined } = {}): Promise<ActionProposal[]> {
    return this.deps.store.getActionProposals(ownerId, filter);
  }

  private async decidable(ownerId: string, id: string): Promise<{ found: ActionProposal } | ActionDecision> {
    const proposal = await this.deps.store.getActionProposal(ownerId, id);
    if (!proposal) return { ok: false, status: 404, error: 'Proposal not found' };
    if (!DECIDABLE.includes(proposal.status)) return { ok: false, status: 409, error: `This proposal is already ${proposal.status}.` };
    return { found: proposal };
  }

  async apply(ownerId: string, id: string): Promise<ActionDecision> {
    const checked = await this.decidable(ownerId, id);
    if (!('found' in checked)) return checked;
    const proposal = checked.found;

    await this.deps.store.saveActionProposal({ ...proposal, status: 'applying', updatedAt: this.now() });
    try {
      const result = await this.execute(ownerId, proposal);
      const applied: ActionProposal = { ...proposal, status: 'applied', result, updatedAt: this.now() };
      delete applied.reason;
      await this.deps.store.saveActionProposal(applied);
      return { ok: true, proposal: applied };
    } catch (err) {
      const failed: ActionProposal = { ...proposal, status: 'failed', reason: (err as Error).message, updatedAt: this.now() };
      await this.deps.store.saveActionProposal(failed);
      return { ok: true, proposal: failed };
    }
  }

  async reject(ownerId: string, id: string): Promise<ActionDecision> {
    const checked = await this.decidable(ownerId, id);
    if (!('found' in checked)) return checked;
    const rejected: ActionProposal = { ...checked.found, status: 'rejected', updatedAt: this.now() };
    await this.deps.store.saveActionProposal(rejected);
    return { ok: true, proposal: rejected };
  }

  private async project(ownerId: string, projectId: string | undefined): Promise<ProjectMetadata> {
    const project = (await this.deps.store.getProjects()).find((candidate) => candidate.id === projectId && candidate.ownerId === ownerId);
    if (!project) throw new Error('the project no longer exists');
    return project;
  }

  private async execute(ownerId: string, proposal: ActionProposal): Promise<string> {
    const { params } = proposal;
    switch (proposal.kind) {
      case 'deploy_app': {
        const deal = await this.deps.deployer.deployApp({
          appType: params.appType, name: params.name, clusterId: params.clusterId, strategy: params.strategy ?? 'native',
        }, ownerId);
        return `deploying ${params.name} (workflow ${deal.id})`;
      }
      case 'deploy_project': {
        const project = await this.project(ownerId, params.projectId);
        const run = (await this.deps.store.getPipelineRuns()).find((candidate) => candidate.id === params.runId && candidate.projectId === project.id);
        if (!run) throw new Error('that build no longer exists');
        const deal = await this.deps.deployer.promoteProjectBuild(project, run, ownerId);
        return `deploying ${project.name} from build ${run.id} (workflow ${deal.id})`;
      }
      case 'set_project_env': {
        const project = await this.project(ownerId, params.projectId);
        await this.deps.store.saveProject({ ...project, deployEnv: params.env ?? '', updatedAt: this.now() } as ProjectMetadata);
        return `${project.name}'s environment is set; it takes effect on the next deploy`;
      }
      case 'add_project_dependency': {
        const out = await declareDependency(this.deps.store, ownerId, { projectId: params.projectId, service: params.service, as: params.as });
        if (out.error) throw new Error(out.error);
        return out.added ? `${out.added.service} is mounted at ${out.readAt} from the next deploy` : (out.note ?? 'nothing to change');
      }
    }
  }
}
