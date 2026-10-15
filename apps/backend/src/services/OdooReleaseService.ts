import { v4 as uuidv4 } from 'uuid';
import type { Client } from '@temporalio/client';
import type { ClusterMetadata, DeploymentMetadata, PipelineRunMetadata, ProjectMetadata } from '../lib/types.js';
import { ODOO_DATABASE_PASSWORD, ODOO_PROJECT_APP, ODOO_RELEASE_SECRETS, chartDatabaseSecret, vaultDatabaseSecret, newReleaseName, type ReleaseVault, releaseNameOf, releasePlace, releaseTargetOf, releaseWorkflowId, rollBackTarget, type OdooRelease, type ReleaseState } from '../lib/odoo-release.js';
import type { ReleaseDecision } from '../lib/release-paths.js';
import { vaultSecretName } from '../lib/infisical-sync.js';
import type { TreeTypeSecret } from '../lib/tree-types.js';
import { startedFor } from '../lib/workflow-owner.js';
import type { ReleaseBuild, ReleaseProgress, ReleaseRollBack, OdooReleaseInput } from '../workflows/OdooReleaseWorkflow.js';

export interface OdooReleaseStore {
  getOdooReleases(ownerId: string, projectId?: string): Promise<OdooRelease[]>;
  saveOdooRelease(release: OdooRelease): Promise<void>;
  getClusters(): Promise<ClusterMetadata[]>;
  getDeployments(): Promise<DeploymentMetadata[]>;
  saveDeploymentInfo(deployment: Partial<DeploymentMetadata> & { id: string }): Promise<DeploymentMetadata>;
  savePipelineRunInfo(run: Partial<PipelineRunMetadata> & { id: string }): Promise<PipelineRunMetadata>;
  saveProjectInfo(project: Partial<ProjectMetadata> & { id: string }): Promise<ProjectMetadata>;
}

export interface ReleaseWorkflows {
  release(workflowId: string, input: OdooReleaseInput, build: ReleaseBuild, owner: string): Promise<void>;
  progress(workflowId: string): Promise<Record<string, ReleaseProgress> | undefined>;
  final(workflowId: string): Promise<Record<string, ReleaseProgress> | undefined>;
  running(workflowId: string): Promise<boolean>;
  decide(workflowId: string, releaseId: string, decision: 'cutOver' | 'discard'): Promise<void>;
  retest(workflowId: string, releaseId: string): Promise<void>;
  rollBack(workflowId: string, input: OdooReleaseInput, rollBack: ReleaseRollBack, owner: string): Promise<void>;
}

export interface ReleaseSecrets {
  ensure(project: ProjectMetadata, options: { seed?: ((key: string) => Promise<string | undefined>) | undefined; fallback?: readonly TreeTypeSecret[] | undefined }): Promise<{ declared: TreeTypeSecret[]; waiting: string[] }>;
  keep(projectId: string, key: string, value: string): Promise<void>;
  chartKeepsOwnSecret(owner: string, repo: string, commit: string): Promise<boolean>;
  onCluster(cluster: ClusterMetadata, namespace: string, secret: string, key: string): Promise<string | undefined>;
}

export type ReleaseDecider = (project: ProjectMetadata, since: string, commit: string) => Promise<ReleaseDecision>;

export interface OdooReleaseDeps {
  store: OdooReleaseStore;
  decide?: ReleaseDecider | undefined;
  secrets?: ReleaseSecrets | undefined;
  workflows: ReleaseWorkflows;
  chartAt: (owner: string, repo: string, commit: string) => Promise<boolean>;
  clusterById?: ((id: string) => Promise<ClusterMetadata | undefined>) | undefined;
  notify?: ((ownerId: string, release: OdooRelease) => void) | undefined;
  now?: (() => string) | undefined;
  newId?: (() => string) | undefined;
  pollMs?: number | undefined;
}

export type ReleaseRefusal = { status: number; error: string };

export interface RollBackOffer {
  from: string;
  to: string;
  commit: string;
  liveSince?: string | undefined;
}

const UNSETTLED: readonly ReleaseState[] = ['preparing', 'preview', 'cutting-over', 'rolling-back'];
const FINAL: readonly ReleaseState[] = ['superseded', 'rolled-back', 'discarded', 'failed'];

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

  async release(project: ProjectMetadata, run: PipelineRunMetadata): Promise<OdooRelease | ReleaseRefusal | { skipped: string }> {
    const refuse = async (error: string): Promise<ReleaseRefusal> => {
      await this.deps.store.savePipelineRunInfo({ id: run.id, releaseRefused: error });
      return { status: 409, error };
    };
    const ownerId = project.ownerId;
    if (!ownerId) return refuse('the project has no owner');
    if (!project.targetClusterId) return refuse('the project has no cluster to deploy to');
    if (!run.imageTag) return refuse('the build has no image to release');
    if (!project.giteaOwner || !project.giteaRepo) return refuse('the project has no repository');
    const cluster = await this.clusterOf(project);
    if (!cluster) return refuse('the project\'s cluster is gone');

    const since = this.deps.decide ? (await this.deps.store.getOdooReleases(ownerId, project.id))
      .filter((entry) => entry.state !== 'failed' && entry.state !== 'discarded')
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]?.commit : undefined;
    if (since && this.deps.decide) {
      const decision = await this.deps.decide(project, since, run.commitSha);
      if (!decision.release) {
        await this.deps.store.savePipelineRunInfo({ id: run.id, releaseSkipped: decision.reason });
        return { skipped: decision.reason };
      }
    }

    const named = await this.named(project, ownerId);
    const place = releasePlace(releaseNameOf(named));
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
    await this.deploymentFor(named, ownerId, cluster, run);

    let vault: ReleaseVault | undefined;
    try {
      vault = await this.vaultFor(named, cluster, run.commitSha);
    } catch (err) {
      const error = `the project's secrets could not be put in its vault: ${(err as Error).message}`;
      await this.deps.store.saveOdooRelease({ ...release, state: 'failed', reason: error, updatedAt: this.now() });
      return refuse(error);
    }
    await this.deps.workflows.release(releaseWorkflowId(project.id), this.inputFor(named, cluster, ownerId), { releaseId: release.id, image: run.imageTag, source: { owner: project.giteaOwner, repo: project.giteaRepo, commit: run.commitSha }, ...(vault ? { vault } : {}) }, ownerId);

    void this.follow(ownerId, project.id);
    return release;
  }

  private async vaultFor(project: ProjectMetadata, cluster: ClusterMetadata, commit: string): Promise<ReleaseVault | undefined> {
    const secrets = this.deps.secrets;
    if (!secrets || !project.giteaOwner || !project.giteaRepo) return undefined;
    const release = releaseNameOf(project);
    const own = await secrets.chartKeepsOwnSecret(project.giteaOwner, project.giteaRepo, commit);
    const carried = own ? chartDatabaseSecret(release) : undefined;
    const running = carried ? await secrets.onCluster(cluster, release, carried.secret, carried.key) : undefined;
    const { declared, waiting } = await secrets.ensure(project, { seed: async (key) => (key === ODOO_DATABASE_PASSWORD ? running : undefined), fallback: ODOO_RELEASE_SECRETS });
    if (declared.length === 0) return undefined;
    if (waiting.length > 0) throw new Error(`waiting for the person to enter ${waiting.join(', ')}`);
    if (running && declared.some((secret) => secret.key === ODOO_DATABASE_PASSWORD)) await secrets.keep(project.id, ODOO_DATABASE_PASSWORD, running);
    const secret = vaultSecretName(release);
    const admin = declared.find((secret) => secret.signInAs);
    return {
      projectId: project.id,
      secret,
      keys: declared.map((entry) => entry.key),
      database: carried ?? vaultDatabaseSecret(release),
      ...(admin ? { adminKey: admin.key } : {}),
    };
  }

  private async named(project: ProjectMetadata, ownerId: string): Promise<ProjectMetadata> {
    if (project.releaseName) return project;
    const deployed = (await this.deps.store.getDeployments()).find((entry) => entry.gitappProjectId === project.id && entry.appType === ODOO_PROJECT_APP);
    const released = deployed !== undefined || (await this.deps.store.getOdooReleases(ownerId, project.id)).length > 0;
    const releaseName = deployed?.namespace || (released ? releaseNameOf(project) : newReleaseName(project));
    await this.deps.store.saveProjectInfo({ id: project.id, releaseName });
    return { ...project, releaseName };
  }

  private async clusterOf(project: ProjectMetadata): Promise<ClusterMetadata | undefined> {
    if (!project.targetClusterId) return undefined;
    return this.deps.clusterById
      ? this.deps.clusterById(project.targetClusterId)
      : (await this.deps.store.getClusters()).find((entry) => entry.id === project.targetClusterId);
  }

  private inputFor(project: ProjectMetadata, cluster: ClusterMetadata, ownerId: string): OdooReleaseInput {
    const place = releasePlace(releaseNameOf(project));
    return { target: releaseTargetOf(cluster, project), host: place.host, previewHost: place.previewHost, ownerId };
  }

  async rollBackOffer(ownerId: string, projectId: string): Promise<RollBackOffer | undefined> {
    const releases = await this.deps.store.getOdooReleases(ownerId, projectId);
    const live = releases.find((release) => release.state === 'live');
    if (!live) return undefined;
    const target = rollBackTarget(releases, live);
    if ('problem' in target) return undefined;
    return { from: live.id, to: target.to.id, commit: target.to.commit, ...(live.liveAt ? { liveSince: live.liveAt } : {}) };
  }

  async rollBack(ownerId: string, project: ProjectMetadata, releaseId: string): Promise<OdooRelease | ReleaseRefusal> {
    const releases = await this.deps.store.getOdooReleases(ownerId, project.id);
    const live = releases.find((entry) => entry.id === releaseId);
    if (!live) return { status: 404, error: 'You have no release with that id' };
    const target = rollBackTarget(releases, live);
    if ('problem' in target) return { status: 409, error: target.problem };
    const cluster = await this.clusterOf(project);
    if (!cluster) return { status: 409, error: 'the project\'s cluster is gone' };
    if (!project.giteaOwner || !project.giteaRepo) return { status: 409, error: 'the project has no repository' };
    const { to } = target;
    await this.deps.workflows.rollBack(releaseWorkflowId(project.id), this.inputFor(project, cluster, ownerId), {
      from: live.id,
      to: { releaseId: to.id, image: to.image, source: { owner: project.giteaOwner, repo: project.giteaRepo, commit: to.commit } },
    }, ownerId);
    void this.follow(ownerId, project.id);
    return live;
  }

  private async deploymentFor(project: ProjectMetadata, ownerId: string, cluster: ClusterMetadata, run: PipelineRunMetadata): Promise<void> {
    const existing = (await this.deps.store.getDeployments()).find((entry) => entry.gitappProjectId === project.id);
    await this.deps.store.saveDeploymentInfo({
      id: existing?.id ?? `odoo-${project.id}`,
      name: project.name,
      clusterId: cluster.id,
      strategy: 'helm',
      appType: ODOO_PROJECT_APP,
      namespace: releaseNameOf(project),
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

  async retest(ownerId: string, releaseId: string): Promise<OdooRelease | ReleaseRefusal> {
    const release = (await this.deps.store.getOdooReleases(ownerId)).find((entry) => entry.id === releaseId);
    if (!release) return { status: 404, error: 'You have no release with that id' };
    if (release.state !== 'preview') return { status: 409, error: `the release is ${release.state}, so its browser tests cannot run again` };
    await this.deps.workflows.retest(releaseWorkflowId(release.projectId), releaseId);
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
      if (!seen) continue;
      const restored = release.state === 'superseded' && seen.state === 'live' && Boolean(seen.restoredAt) && seen.restoredAt !== release.restoredAt;
      if (FINAL.includes(release.state) && !restored) continue;
      if (seen.state === release.state && seen.slot === release.slot && seen.reason === release.reason && JSON.stringify(seen.e2e) === JSON.stringify(release.e2e)) continue;
      const { replacedBy: _replacedBy, reason: _reason, ...kept } = release;
      const stamp = this.now();
      const updated: OdooRelease = {
        ...(restored ? kept : release),
        state: seen.state,
        ...(seen.slot ? { slot: seen.slot } : {}),
        ...(seen.reason ? { reason: seen.reason } : {}),
        ...(seen.e2e ? { e2e: seen.e2e } : {}),
        ...(seen.state === 'live' && release.state !== 'live' ? { liveAt: stamp } : {}),
        ...(restored ? { restoredAt: seen.restoredAt } : {}),
        updatedAt: stamp,
      };
      await this.deps.store.saveOdooRelease(updated);
      this.deps.notify?.(ownerId, updated);
      if (seen.state === 'live') {
        await this.deploymentState(projectId, 'running', release.image);
        for (const earlier of releases.filter((other) => other.id !== release.id && other.state === 'live' && other.startedAt <= release.startedAt)) {
          const replaced: OdooRelease = { ...earlier, state: 'superseded', reason: `replaced by the release of ${release.commit.slice(0, 8)}`, replacedBy: release.id, updatedAt: this.now() };
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

  private async deploymentState(projectId: string, status: DeploymentMetadata['status'], image?: string): Promise<void> {
    const deployment = (await this.deps.store.getDeployments()).find((entry) => entry.gitappProjectId === projectId);
    if (!deployment || (deployment.status === status && (!image || deployment.gitappImageTag === image))) return;
    await this.deps.store.saveDeploymentInfo({ id: deployment.id, status, ...(image ? { gitappImageTag: image } : {}) });
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
    async retest(workflowId, releaseId) {
      await connected().workflow.getHandle(workflowId).signal('retest', releaseId);
    },
    async rollBack(workflowId, input, rollBack, owner) {
      await connected().workflow.signalWithStart('OdooReleaseWorkflow', { workflowId, taskQueue, args: [input], signal: 'rollBack', signalArgs: [rollBack], ...startedFor(owner) });
    },
  };
}
