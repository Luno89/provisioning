import { v4 as uuidv4 } from 'uuid';
import type { Client } from '@temporalio/client';
import type { ClusterMetadata, DeploymentMetadata, PipelineRunMetadata, ProjectMetadata } from '../lib/types.js';
import { ODOO_PROJECT_APP, releasePlace, releaseWorkflowId, type OdooRelease, type ReleaseState } from '../lib/odoo-release.js';
import { startedFor } from '../lib/workflow-owner.js';
import type { ReleaseBuild, ReleaseProgress, OdooReleaseInput } from '../workflows/OdooReleaseWorkflow.js';

export interface OdooReleaseStore {
  getOdooReleases(ownerId: string, projectId?: string): Promise<OdooRelease[]>;
  saveOdooRelease(release: OdooRelease): Promise<void>;
  getClusters(): Promise<ClusterMetadata[]>;
  getDeployments(): Promise<DeploymentMetadata[]>;
  saveDeploymentInfo(deployment: Partial<DeploymentMetadata> & { id: string }): Promise<DeploymentMetadata>;
}

export interface ReleaseWorkflows {
  release(workflowId: string, input: OdooReleaseInput, build: ReleaseBuild, owner: string): Promise<void>;
  progress(workflowId: string): Promise<Record<string, ReleaseProgress> | undefined>;
  final(workflowId: string): Promise<Record<string, ReleaseProgress> | undefined>;
  running(workflowId: string): Promise<boolean>;
  decide(workflowId: string, releaseId: string, decision: 'cutOver' | 'discard'): Promise<void>;
}

export interface OdooReleaseDeps {
  store: OdooReleaseStore;
  workflows: ReleaseWorkflows;
  chartAt: (owner: string, repo: string, commit: string) => Promise<boolean>;
  clusterById?: ((id: string) => Promise<ClusterMetadata | undefined>) | undefined;
  notify?: ((ownerId: string, release: OdooRelease) => void) | undefined;
  now?: (() => string) | undefined;
  newId?: (() => string) | undefined;
  pollMs?: number | undefined;
}

export type ReleaseRefusal = { status: number; error: string };

const UNSETTLED: readonly ReleaseState[] = ['preparing', 'preview', 'cutting-over'];
const FINAL: readonly ReleaseState[] = ['superseded', 'discarded', 'failed'];

export class OdooReleaseService {
  private readonly following = new Map<string, Promise<void>>();

  constructor(private readonly deps: OdooReleaseDeps) {}

  private now(): string {
    return (this.deps.now ?? (() => new Date().toISOString()))();
  }

  async releasesByChart(project: Pick<ProjectMetadata, 'giteaOwner' | 'giteaRepo'>, commit: string): Promise<boolean> {
    if (!project.giteaOwner || !project.giteaRepo) return false;
    return this.deps.chartAt(project.giteaOwner, project.giteaRepo, commit);
  }

  async release(project: ProjectMetadata, run: PipelineRunMetadata): Promise<OdooRelease | ReleaseRefusal> {
    const ownerId = project.ownerId;
    if (!ownerId) return { status: 409, error: 'the project has no owner' };
    if (!project.targetClusterId) return { status: 409, error: 'the project has no cluster to deploy to' };
    if (!run.imageTag) return { status: 409, error: 'the build has no image to release' };
    if (!project.giteaOwner || !project.giteaRepo) return { status: 409, error: 'the project has no repository' };
    const cluster = this.deps.clusterById
      ? await this.deps.clusterById(project.targetClusterId)
      : (await this.deps.store.getClusters()).find((entry) => entry.id === project.targetClusterId);
    if (!cluster) return { status: 409, error: 'the project\'s cluster is gone' };

    const place = releasePlace(project.name);
    const stamp = this.now();
    const release: OdooRelease = {
      id: (this.deps.newId ?? uuidv4)(),
      ownerId,
      projectId: project.id,
      pipelineRunId: run.id,
      commit: run.commitSha,
      image: run.imageTag,
      state: 'preparing',
      host: place.host,
      previewHost: place.previewHost,
      startedAt: stamp,
      updatedAt: stamp,
    };
    await this.deps.store.saveOdooRelease(release);
    await this.deploymentFor(project, ownerId, cluster, run);

    await this.deps.workflows.release(releaseWorkflowId(project.id), {
      target: {
        clusterName: cluster.name,
        provider: cluster.provider,
        ...(cluster.gpuEnabled ? { gpuEnabled: true } : {}),
        ...(cluster.kubeconfigPath ? { kubeconfigPath: cluster.kubeconfigPath } : {}),
        namespace: place.namespace,
        release: place.release,
      },
      host: place.host,
      previewHost: place.previewHost,
    }, { releaseId: release.id, image: run.imageTag, source: { owner: project.giteaOwner, repo: project.giteaRepo, commit: run.commitSha } }, ownerId);

    void this.follow(ownerId, project.id);
    return release;
  }

  private async deploymentFor(project: ProjectMetadata, ownerId: string, cluster: ClusterMetadata, run: PipelineRunMetadata): Promise<void> {
    const existing = (await this.deps.store.getDeployments()).find((entry) => entry.gitappProjectId === project.id);
    await this.deps.store.saveDeploymentInfo({
      id: existing?.id ?? `odoo-${project.id}`,
      name: project.name,
      clusterId: cluster.id,
      strategy: 'helm',
      appType: ODOO_PROJECT_APP,
      ownerId,
      gitappProjectId: project.id,
      gitappImageTag: run.imageTag!,
      status: existing?.status === 'running' ? 'running' : 'deploying',
      ...(existing ? {} : { createdAt: this.now() }),
    } as Partial<DeploymentMetadata> & { id: string });
  }

  async list(ownerId: string, projectId: string): Promise<OdooRelease[]> {
    return this.deps.store.getOdooReleases(ownerId, projectId);
  }

  async addresses(projectId: string): Promise<{ live?: string; preview?: string }> {
    const deployment = (await this.deps.store.getDeployments()).find((entry) => entry.gitappProjectId === projectId && entry.appType === ODOO_PROJECT_APP);
    const live = deployment?.publicExposureUrl ?? deployment?.localExposureUrl;
    const preview = deployment?.previewPublicUrl ?? deployment?.previewLocalUrl;
    return { ...(live ? { live } : {}), ...(preview ? { preview } : {}) };
  }

  async decide(ownerId: string, releaseId: string, decision: 'cutOver' | 'discard'): Promise<OdooRelease | ReleaseRefusal> {
    const release = (await this.deps.store.getOdooReleases(ownerId)).find((entry) => entry.id === releaseId);
    if (!release) return { status: 404, error: 'You have no release with that id' };
    if (release.state !== 'preview') return { status: 409, error: `the release is ${release.state}, not waiting in preview` };
    await this.deps.workflows.decide(releaseWorkflowId(release.projectId), releaseId, decision);
    void this.follow(ownerId, release.projectId);
    return release;
  }

  async recover(ownerIds: readonly string[]): Promise<number> {
    let followed = 0;
    for (const ownerId of ownerIds) {
      const projects = new Set((await this.deps.store.getOdooReleases(ownerId)).filter((release) => UNSETTLED.includes(release.state)).map((release) => release.projectId));
      for (const projectId of projects) {
        void this.follow(ownerId, projectId);
        followed += 1;
      }
    }
    return followed;
  }

  follow(ownerId: string, projectId: string): Promise<void> {
    const key = `${ownerId}:${projectId}`;
    const already = this.following.get(key);
    if (already) return already;
    const followed = this.watch(ownerId, projectId).finally(() => this.following.delete(key));
    this.following.set(key, followed);
    return followed;
  }

  private async watch(ownerId: string, projectId: string): Promise<void> {
    const workflowId = releaseWorkflowId(projectId);
    for (;;) {
      const running = await this.deps.workflows.running(workflowId).catch(() => false);
      const progress = running
        ? await this.deps.workflows.progress(workflowId).catch(() => undefined)
        : await this.deps.workflows.final(workflowId).catch(() => undefined);
      if (progress) await this.record(ownerId, projectId, progress);
      if (!running) {
        await this.abandon(ownerId, projectId);
        return;
      }
      await new Promise((done) => setTimeout(done, this.deps.pollMs ?? 3_000));
    }
  }

  private async record(ownerId: string, projectId: string, progress: Record<string, ReleaseProgress>): Promise<void> {
    const releases = await this.deps.store.getOdooReleases(ownerId, projectId);
    for (const release of releases) {
      const seen = progress[release.id];
      if (!seen || FINAL.includes(release.state)) continue;
      if (seen.state === release.state && seen.slot === release.slot && seen.reason === release.reason) continue;
      const updated: OdooRelease = {
        ...release,
        state: seen.state,
        ...(seen.slot ? { slot: seen.slot } : {}),
        ...(seen.reason ? { reason: seen.reason } : {}),
        updatedAt: this.now(),
      };
      await this.deps.store.saveOdooRelease(updated);
      this.deps.notify?.(ownerId, updated);
      if (seen.state === 'live') {
        await this.deploymentState(projectId, 'running');
        for (const earlier of releases.filter((other) => other.id !== release.id && other.state === 'live' && other.startedAt <= release.startedAt)) {
          const replaced: OdooRelease = { ...earlier, state: 'superseded', reason: `replaced by the release of ${release.commit.slice(0, 8)}`, updatedAt: this.now() };
          await this.deps.store.saveOdooRelease(replaced);
          this.deps.notify?.(ownerId, replaced);
        }
      }
      if (seen.state === 'failed' && !releases.some((other) => other.state === 'live' || other.state === 'superseded')) await this.deploymentState(projectId, 'failed');
    }
  }

  private async abandon(ownerId: string, projectId: string): Promise<void> {
    for (const release of await this.deps.store.getOdooReleases(ownerId, projectId)) {
      if (!UNSETTLED.includes(release.state)) continue;
      const updated: OdooRelease = { ...release, state: 'failed', reason: 'the release stopped being followed before it finished', updatedAt: this.now() };
      await this.deps.store.saveOdooRelease(updated);
      this.deps.notify?.(ownerId, updated);
    }
  }

  private async deploymentState(projectId: string, status: DeploymentMetadata['status']): Promise<void> {
    const deployment = (await this.deps.store.getDeployments()).find((entry) => entry.gitappProjectId === projectId);
    if (deployment && deployment.status !== status) await this.deps.store.saveDeploymentInfo({ id: deployment.id, status });
  }
}

export function temporalReleaseWorkflows(client: () => Client | undefined | null, taskQueue: string): ReleaseWorkflows {
  const connected = (): Client => {
    const temporal = client();
    if (!temporal) throw new Error('Temporal is not reachable');
    return temporal;
  };
  return {
    async release(workflowId, input, build, owner) {
      await connected().workflow.signalWithStart('OdooReleaseWorkflow', { workflowId, taskQueue, args: [input], signal: 'releaseBuild', signalArgs: [build], ...startedFor(owner) });
    },
    async progress(workflowId) {
      return connected().workflow.getHandle(workflowId).query<Record<string, ReleaseProgress>>('releases');
    },
    async final(workflowId) {
      return connected().workflow.getHandle(workflowId).result() as Promise<Record<string, ReleaseProgress>>;
    },
    async running(workflowId) {
      return (await connected().workflow.getHandle(workflowId).describe()).status.name === 'RUNNING';
    },
    async decide(workflowId, releaseId, decision) {
      await connected().workflow.getHandle(workflowId).signal(decision, releaseId);
    },
  };
}
