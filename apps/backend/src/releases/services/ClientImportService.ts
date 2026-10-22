import type { ClusterMetadata, PipelineRunMetadata, ProjectMetadata } from '../../platform/index.js';
import { releaseTargetOf, type OdooRelease } from '../lib/odoo-release.js';
import type { SlotAdapter } from '../../extensions/releases/adapter.js';
import type { SlotCluster } from '../../extensions/releases/slot-cluster.js';
import {
  DISCARD_COMMAND, MANIFEST_COMMAND, RECEIVE_COMMAND, claimManifest, holderManifest, importClaim, importHolder, restoreJobName, isImportMode, majorOf, parseManifest, versionProblem,
  type ClientImport, type ImportMode,
} from '../lib/client-import.js';

export type ImportOutcome<T> = { ok: true; value: T } | { ok: false; status: 400 | 404 | 409 | 411 | 500; error: string };

export interface ImportView {
  import?: ClientImport | undefined;
  open: boolean;
  why?: string | undefined;
}

export interface ClientImportDeps {
  projects(): Promise<ProjectMetadata[]>;
  saveProject(patch: Partial<ProjectMetadata> & { id: string }): Promise<unknown>;
  clusterById(id: string): Promise<ClusterMetadata | undefined>;
  adapterOf(project: ProjectMetadata): Promise<SlotAdapter | undefined>;
  cluster: SlotCluster;
  odooVersion(project: ProjectMetadata): Promise<string | undefined>;
  latestBuild(project: ProjectMetadata): Promise<PipelineRunMetadata | undefined>;
  releases: {
    established(ownerId: string, projectId: string): Promise<OdooRelease | undefined>;
    nameRelease(project: ProjectMetadata): Promise<ProjectMetadata>;
    release(project: ProjectMetadata, run: PipelineRunMetadata): Promise<unknown>;
  };
  now?: (() => string) | undefined;
}

const BUSY: readonly ClientImport['state'][] = ['uploading', 'importing'];
const SET_ASIDE: readonly ClientImport['state'][] = ['awaited', 'uploaded', 'refused', 'failed'];

export class ClientImportService {
  constructor(private readonly deps: ClientImportDeps) {}

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  private async mine(ownerId: string, projectId: string): Promise<ProjectMetadata | undefined> {
    return (await this.deps.projects()).find((entry) => entry.id === projectId && entry.ownerId === ownerId);
  }

  private async closed(project: ProjectMetadata): Promise<{ status: 409; why: string } | undefined> {
    const adapter = await this.deps.adapterOf(project);
    if (!adapter?.restore) return { status: 409, why: `${project.name} is not released with an app that can start from a client's database` };
    if (!project.targetClusterId || !(await this.deps.clusterById(project.targetClusterId))) return { status: 409, why: `${project.name} has no cluster to run the client's database on` };
    const established = await this.deps.releases.established(project.ownerId!, project.id);
    if (established) return { status: 409, why: `${project.name} has already released (${established.commit.slice(0, 8)} is ${established.state}); a client's database can only start a project` };
    const entry = project.clientImport as ClientImport | undefined;
    if (entry && BUSY.includes(entry.state)) return { status: 409, why: `the client's database is already being ${entry.state === 'uploading' ? 'uploaded' : 'imported'}` };
    return undefined;
  }

  async view(ownerId: string, projectId: string): Promise<ImportOutcome<ImportView>> {
    const project = await this.mine(ownerId, projectId);
    if (!project) return { ok: false, status: 404, error: 'You have no project with that id' };
    const closed = await this.closed(project);
    const entry = project.clientImport as ClientImport | undefined;
    return { ok: true, value: { ...(entry ? { import: entry } : {}), open: !closed, ...(closed ? { why: closed.why } : {}) } };
  }

  async startFresh(ownerId: string, projectId: string): Promise<ImportOutcome<{ released: boolean }>> {
    const project = await this.mine(ownerId, projectId);
    if (!project) return { ok: false, status: 404, error: 'You have no project with that id' };
    const entry = project.clientImport as ClientImport | undefined;
    if (!entry || !SET_ASIDE.includes(entry.state)) return { ok: false, status: 409, error: entry ? `the client's database is ${entry.state}, so there is nothing to start without` : `${project.name} is not waiting for a client's database` };
    const established = await this.deps.releases.established(ownerId, projectId);
    if (established) return { ok: false, status: 409, error: `${project.name} has already released` };
    await this.deps.saveProject({ id: project.id, clientImport: null });
    const cluster = project.targetClusterId ? await this.deps.clusterById(project.targetClusterId) : undefined;
    if (cluster && project.releaseName) {
      const target = releaseTargetOf(cluster, project);
      await this.deps.cluster.remove(target, 'job', restoreJobName(project.releaseName, 'a'), true).catch(() => undefined);
      await this.deps.cluster.remove(target, 'pvc', importClaim(project.releaseName)).catch(() => undefined);
    }
    const build = await this.deps.latestBuild(project);
    if (build) await this.deps.releases.release({ ...project, clientImport: undefined }, build);
    return { ok: true, value: { released: Boolean(build) } };
  }

  async upload(ownerId: string, projectId: string, input: { mode: unknown; bytes: number; body: NodeJS.ReadableStream }): Promise<ImportOutcome<ClientImport>> {
    const project = await this.mine(ownerId, projectId);
    if (!project) return { ok: false, status: 404, error: 'You have no project with that id' };
    if (!isImportMode(input.mode)) return { ok: false, status: 400, error: 'mode is copy (a neutralized copy to work on) or live (the client\'s live system)' };
    if (!Number.isFinite(input.bytes) || input.bytes <= 0) return { ok: false, status: 411, error: 'say how big the backup is (Content-Length)' };
    const closed = await this.closed(project);
    if (closed) return { ok: false, status: closed.status, error: closed.why };
    const major = await this.deps.odooVersion(project);
    if (!major) return { ok: false, status: 409, error: `cannot tell which Odoo ${project.name} runs` };

    const named = await this.deps.releases.nameRelease(project);
    const cluster = (await this.deps.clusterById(named.targetClusterId!))!;
    const target = releaseTargetOf(cluster, named);
    const holder = importHolder(target.release);
    const mode: ImportMode = input.mode;
    const record = async (entry: ClientImport): Promise<ClientImport> => {
      await this.deps.saveProject({ id: project.id, clientImport: entry });
      return entry;
    };
    await record({ state: 'uploading', mode, bytes: input.bytes, at: this.now() });

    let entry: ClientImport;
    try {
      await this.deps.cluster.remove(target, 'pod', holder, true);
      await this.deps.cluster.remove(target, 'job', restoreJobName(target.release, 'a'), true);
      await this.deps.cluster.remove(target, 'pvc', importClaim(target.release), true);
      await this.deps.cluster.put(target, claimManifest(target.release, input.bytes));
      await this.deps.cluster.put(target, holderManifest(target.release));
      await this.deps.cluster.running(target, holder);
      await this.deps.cluster.pipe(target, holder, RECEIVE_COMMAND, input.body);
      const manifest = parseManifest(await this.deps.cluster.exec(target, holder, MANIFEST_COMMAND).catch(() => ''));
      const problem = versionProblem(manifest, major);
      if (problem) {
        await this.deps.cluster.exec(target, holder, DISCARD_COMMAND);
        await record({ state: 'refused', mode, bytes: input.bytes, ...(manifest && majorOf(manifest) ? { version: majorOf(manifest) } : {}), reason: problem, at: this.now() });
        return { ok: false, status: 409, error: problem };
      }
      entry = await record({ state: 'uploaded', mode, bytes: input.bytes, version: majorOf(manifest!), modules: Object.keys(manifest!.modules ?? {}).sort(), at: this.now() });
    } catch (err) {
      const reason = `the backup could not be taken in: ${(err as Error).message}`;
      await record({ state: 'failed', mode, bytes: input.bytes, reason, at: this.now() });
      return { ok: false, status: 500, error: reason };
    } finally {
      await this.deps.cluster.remove(target, 'pod', holder).catch(() => undefined);
    }

    const build = await this.deps.latestBuild(named);
    if (build) await this.deps.releases.release({ ...named, clientImport: entry }, build);
    return { ok: true, value: entry };
  }
}
