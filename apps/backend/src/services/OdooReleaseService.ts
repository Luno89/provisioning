import { lossLines } from '../lib/release-compare.js';
import { v4 as uuidv4 } from 'uuid';
import type { ClusterMetadata, DeploymentMetadata, PipelineRunMetadata, ProjectMetadata } from '../lib/types.js';
import { ODOO_DATABASE_PASSWORD, ODOO_PROJECT_APP, ODOO_RELEASE_SECRETS, chartDatabaseSecret, vaultDatabaseSecret, newReleaseName, type ReleaseVault, releaseNameOf, releasePlace, releaseTargetOf, rollBackTarget, type OdooRelease, type ReleaseState } from '../lib/odoo-release.js';
import type { ReleaseDecision } from '../lib/release-paths.js';
import { missingFrom, missingSentence, restorable, wrongVersionFrom, type ClientImport } from '../lib/client-import.js';
import { vaultSecretName } from '../lib/infisical-sync.js';
import type { TreeTypeSecret } from '../lib/tree-types.js';
import { isMockCloudProvider } from '../lib/cluster-topology.js';
import { hasCloudCredentials } from '../lib/credential-resolver.js';
import {
  CUT_OVER, CUT_OVER_LOSING, DECISION_NODE, DEFAULT_RELEASE_APP, DISCARD, LOSING_DECISION_NODE, RELEASE_AGENT, RETEST, ROLL_BACK_AGENT, UNSETTLED_STATES,
  type ReleaseBuildInput, type ReleaseHow, type ReleaseRunInput, type RollBackRunInput,
} from '../lib/release-run.js';

export interface OdooReleaseStore {
  getOdooReleases(ownerId: string, projectId?: string): Promise<OdooRelease[]>;
  saveOdooRelease(release: OdooRelease): Promise<void>;
  getProjects(): Promise<ProjectMetadata[]>;
  getClusters(): Promise<ClusterMetadata[]>;
  getDeployments(): Promise<DeploymentMetadata[]>;
  saveDeploymentInfo(deployment: Partial<DeploymentMetadata> & { id: string }): Promise<DeploymentMetadata>;
  savePipelineRunInfo(run: Partial<PipelineRunMetadata> & { id: string }): Promise<PipelineRunMetadata>;
  saveProjectInfo(project: Partial<ProjectMetadata> & { id: string }): Promise<ProjectMetadata>;
}

export interface ReleaseRuns {
  start(request: { projectId: string; ownerId: string; agent: string; inputs: ReleaseRunInput | RollBackRunInput }): Promise<void>;
  running(projectId: string): Promise<boolean>;
  answer(projectId: string, choice: string, nodeId?: string): Promise<void>;
  stop(projectId: string): Promise<void>;
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
  runs: ReleaseRuns;
  how?: ((project: ProjectMetadata) => Promise<ReleaseHow>) | undefined;
  chartAt: (owner: string, repo: string, commit: string) => Promise<boolean>;
  clusterById?: ((id: string) => Promise<ClusterMetadata | undefined>) | undefined;
  notify?: ((ownerId: string, release: OdooRelease) => void) | undefined;
  now?: (() => string) | undefined;
  newId?: (() => string) | undefined;
  pollMs?: number | undefined;
}

export type ReleaseRefusal = { status: number; error: string; losing?: string[] | undefined };

export interface RollBackOffer {
  from: string;
  to: string;
  commit: string;
  liveSince?: string | undefined;
}

const IN_FLIGHT: readonly ReleaseState[] = UNSETTLED_STATES.filter((state) => state !== 'queued');
const ESTABLISHED: readonly ReleaseState[] = ['live', 'superseded', 'rolled-back', 'cutting-over', 'rolling-back'];

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
      .filter((entry) => entry.state !== 'failed' && entry.state !== 'discarded' && entry.state !== 'queued')
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
    const busy = await this.deps.runs.running(project.id);
    const fromClient = restorable(named.clientImport as ClientImport | undefined) && !(await this.deps.store.getOdooReleases(ownerId, project.id)).some((entry) => ESTABLISHED.includes(entry.state))
      ? named.clientImport as ClientImport
      : undefined;
    const release: OdooRelease = {
      id: (this.deps.newId ?? uuidv4)(),
      ownerId,
      projectId: project.id,
      pipelineRunId: run.id,
      commit: run.commitSha,
      image: run.imageTag,
      state: busy ? 'queued' : 'preparing',
      host: place.host,
      previewHost: place.previewHost,
      ...(fromClient ? { restore: { mode: fromClient.mode, version: fromClient.version, modules: fromClient.modules?.length ?? 0 } } : {}),
      startedAt: stamp,
      updatedAt: stamp,
    };
    await this.deps.store.saveOdooRelease(release);
    if (fromClient) await this.deps.store.saveProjectInfo({ id: project.id, clientImport: { ...fromClient, state: 'importing', releaseId: release.id, reason: undefined, missing: undefined, at: stamp } });
    await this.deploymentFor(named, ownerId, cluster, run);

    if (busy) {
      const waiting = (await this.deps.store.getOdooReleases(ownerId, project.id)).some((entry) => entry.state === 'preview');
      if (waiting) await this.deps.runs.stop(project.id);
    } else {
      const started = await this.startRelease(named, cluster, release);
      if ('error' in started) return refuse(started.error);
    }
    void this.follow(ownerId, project.id);
    return release;
  }

  private async startRelease(project: ProjectMetadata, cluster: ClusterMetadata, release: OdooRelease): Promise<{ ok: true } | { error: string }> {
    let vault: ReleaseVault | undefined;
    try {
      vault = await this.vaultFor(project, cluster, release.commit);
    } catch (err) {
      const error = `the project's secrets could not be put in its vault: ${(err as Error).message}`;
      await this.save({ ...release, state: 'failed', reason: error, updatedAt: this.now() });
      return { error };
    }
    if (release.state !== 'preparing') await this.save({ ...release, state: 'preparing', updatedAt: this.now() });
    const how = await this.howOf(project);
    await this.deps.runs.start({
      projectId: project.id,
      ownerId: release.ownerId,
      agent: how.agent,
      inputs: { ...this.inputFor(project, cluster, release.ownerId, how.app), build: this.buildOf(project, release, vault) },
    });
    return { ok: true };
  }

  private buildOf(project: ProjectMetadata, release: OdooRelease, vault?: ReleaseVault | undefined): ReleaseBuildInput {
    return {
      releaseId: release.id,
      image: release.image,
      source: { owner: project.giteaOwner!, repo: project.giteaRepo!, commit: release.commit },
      ...(vault ? { vault } : {}),
      ...(release.restore ? { restore: { mode: release.restore.mode } } : {}),
    };
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

  async nameRelease(project: ProjectMetadata): Promise<ProjectMetadata> {
    return this.named(project, project.ownerId!);
  }

  async established(ownerId: string, projectId: string): Promise<OdooRelease | undefined> {
    return (await this.deps.store.getOdooReleases(ownerId, projectId)).find((entry) => ESTABLISHED.includes(entry.state) || IN_FLIGHT.includes(entry.state));
  }

  private async settleImport(release: OdooRelease): Promise<void> {
    if (!release.restore || (release.state !== 'live' && release.state !== 'failed')) return;
    const project = (await this.deps.store.getProjects()).find((entry) => entry.id === release.projectId);
    const entry = project?.clientImport as ClientImport | undefined;
    if (!project || !entry || entry.releaseId !== release.id || entry.state !== 'importing') return;
    const at = this.now();
    if (release.state === 'live') {
      await this.deps.store.saveProjectInfo({ id: project.id, clientImport: { ...entry, state: 'imported', at } });
      return;
    }
    const missing = missingFrom(release.reason ?? '');
    const wrong = wrongVersionFrom(release.reason ?? '');
    await this.deps.store.saveProjectInfo({
      id: project.id,
      clientImport: missing
        ? { ...entry, state: 'refused', missing, reason: missingSentence(missing), at }
        : wrong
          ? { ...entry, state: 'refused', reason: wrong, at }
          : { ...entry, state: 'failed', reason: release.reason ?? 'the release failed without saying why', at },
    });
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

  private async howOf(project: ProjectMetadata): Promise<ReleaseHow> {
    return (await this.deps.how?.(project)) ?? { agent: RELEASE_AGENT, app: DEFAULT_RELEASE_APP };
  }

  private inputFor(project: ProjectMetadata, cluster: ClusterMetadata, ownerId: string, app: string = DEFAULT_RELEASE_APP): Omit<ReleaseRunInput, 'build'> {
    const place = releasePlace(releaseNameOf(project));
    const target = releaseTargetOf(cluster, project);
    return {
      ownerId,
      projectId: project.id,
      adapter: app,
      target,
      host: place.host,
      previewHost: place.previewHost,
      secretTarget: { clusterName: cluster.name, provider: cluster.provider, isMock: isMockCloudProvider(cluster.provider, hasCloudCredentials) },
    };
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
    if (await this.deps.runs.running(project.id)) {
      const waiting = releases.some((entry) => entry.state === 'preview');
      return { status: 409, error: waiting ? 'a preview is waiting: cut it over or discard it first' : 'a release is in progress: wait for it to finish' };
    }
    const cluster = await this.clusterOf(project);
    if (!cluster) return { status: 409, error: 'the project\'s cluster is gone' };
    if (!project.giteaOwner || !project.giteaRepo) return { status: 409, error: 'the project has no repository' };
    await this.deps.runs.start({
      projectId: project.id,
      ownerId,
      agent: ROLL_BACK_AGENT,
      inputs: { ...this.inputFor(project, cluster, ownerId, (await this.howOf(project)).app), from: live.id, to: this.buildOf(project, target.to) },
    });
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

  private async waitingPreview(ownerId: string, releaseId: string, doing: string): Promise<OdooRelease | ReleaseRefusal> {
    const release = (await this.deps.store.getOdooReleases(ownerId)).find((entry) => entry.id === releaseId);
    if (!release) return { status: 404, error: 'You have no release with that id' };
    if (release.state !== 'preview') return { status: 409, error: `the release is ${release.state}, so it cannot be ${doing}` };
    if (release.e2e?.state === 'running') return { status: 409, error: `its browser tests are still running, so it cannot be ${doing} yet` };
    if (!(await this.deps.runs.running(release.projectId))) return { status: 409, error: `no release is waiting for this preview, so it cannot be ${doing}: push again to release it` };
    return release;
  }

  async decide(ownerId: string, releaseId: string, decision: 'cutOver' | 'discard', confirmed = false): Promise<OdooRelease | ReleaseRefusal> {
    const release = await this.waitingPreview(ownerId, releaseId, decision === 'cutOver' ? 'cut over' : 'discarded');
    if ('status' in release) return release;
    const losing = release.changes?.losing === true;
    if (decision === 'cutOver' && losing && !confirmed) {
      return { status: 409, error: `cutting this release over would lose: ${lossLines(release.changes!).join('; ')}. Confirm the loss to cut over anyway`, losing: lossLines(release.changes!) };
    }
    const node = losing ? LOSING_DECISION_NODE : DECISION_NODE;
    await this.deps.runs.answer(release.projectId, decision === 'discard' ? DISCARD : losing ? CUT_OVER_LOSING : CUT_OVER, node);
    void this.follow(ownerId, release.projectId);
    return release;
  }

  async retest(ownerId: string, releaseId: string): Promise<OdooRelease | ReleaseRefusal> {
    const release = await this.waitingPreview(ownerId, releaseId, 'tested again');
    if ('status' in release) return release;
    await this.deps.runs.answer(release.projectId, RETEST, release.changes?.losing ? LOSING_DECISION_NODE : DECISION_NODE);
    void this.follow(ownerId, release.projectId);
    return release;
  }

  async recover(ownerIds: readonly string[]): Promise<number> {
    let followed = 0;
    for (const ownerId of ownerIds) {
      const projects = new Set((await this.deps.store.getOdooReleases(ownerId)).filter((release) => UNSETTLED_STATES.includes(release.state)).map((release) => release.projectId));
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

  private async save(release: OdooRelease): Promise<void> {
    await this.deps.store.saveOdooRelease(release);
    await this.settleImport(release);
    this.deps.notify?.(release.ownerId, release);
  }

  private async watch(ownerId: string, projectId: string): Promise<void> {
    const seen = new Map((await this.deps.store.getOdooReleases(ownerId, projectId)).map((release) => [release.id, release.updatedAt]));
    for (;;) {
      const running = await this.deps.runs.running(projectId).catch(() => true);
      const releases = await this.deps.store.getOdooReleases(ownerId, projectId);
      for (const release of releases) {
        if (seen.get(release.id) === release.updatedAt) continue;
        seen.set(release.id, release.updatedAt);
        await this.settleImport(release);
        this.deps.notify?.(ownerId, release);
        if (release.state === 'live') await this.deploymentState(projectId, 'running', release.image);
        if (release.state === 'failed' && !releases.some((other) => other.state === 'live' || other.state === 'superseded')) await this.deploymentState(projectId, 'failed');
      }
      if (!running) {
        for (const release of releases.filter((entry) => IN_FLIGHT.includes(entry.state))) {
          const updated: OdooRelease = { ...release, state: 'failed', reason: 'the release stopped before it said how it went', updatedAt: this.now() };
          await this.save(updated);
          seen.set(updated.id, updated.updatedAt);
        }
        const queued = releases.filter((entry) => entry.state === 'queued').sort((a, b) => b.startedAt.localeCompare(a.startedAt));
        for (const older of queued.slice(1)) {
          const updated: OdooRelease = { ...older, state: 'superseded', reason: 'a newer build took its place', updatedAt: this.now() };
          await this.save(updated);
          seen.set(updated.id, updated.updatedAt);
        }
        const next = queued[0];
        if (!next) return;
        const project = (await this.deps.store.getProjects()).find((entry) => entry.id === projectId);
        const cluster = project ? await this.clusterOf(project) : undefined;
        if (!project || !cluster) {
          await this.save({ ...next, state: 'failed', reason: project ? 'the project\'s cluster is gone' : 'the project is gone', updatedAt: this.now() });
          return;
        }
        const started = await this.startRelease(project, cluster, next);
        if ('error' in started) return;
      }
      await new Promise((done) => setTimeout(done, this.deps.pollMs ?? 3_000));
    }
  }

  private async deploymentState(projectId: string, status: DeploymentMetadata['status'], image?: string): Promise<void> {
    const deployment = (await this.deps.store.getDeployments()).find((entry) => entry.gitappProjectId === projectId);
    if (!deployment || (deployment.status === status && (!image || deployment.gitappImageTag === image))) return;
    await this.deps.store.saveDeploymentInfo({ id: deployment.id, status, ...(image ? { gitappImageTag: image } : {}) });
  }
}

