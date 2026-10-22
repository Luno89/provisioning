import { afterMove, afterRemove, marked, sharing, type ClientMark } from '../../hub/lib/client-files.js';
import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { DeploymentMetadata, ProjectMetadata } from '../../platform/index.js';
import { fileServersOf, folderFor, type FileEntry, type FilePlace, type FileServer, type FileSettings } from '../lib/file-places.js';
import type { Download, FileStore } from './FileStores.js';
import { shareExpires, shareLive, SHARE_TOKEN, type FileShare, type ShareDays } from '../lib/file-shares.js';

export const PERSONAL_FOLDER = 'personal';
export const FILES_APP_NAME = 'koala-files';

export interface FileServiceDeps {
  store: {
    infrastructure: {
      getDeployments(): Promise<DeploymentMetadata[]>;
    };
    files: {
      getFileSettings(ownerId: string): Promise<FileSettings | undefined>;
      getFileShares(ownerId: string): Promise<FileShare[]>;
      getFileShare(id: string): Promise<FileShare | undefined>;
      saveFileShare(share: FileShare): Promise<void>;
      deleteFileShare(id: string): Promise<void>;
      saveFileSettings(settings: FileSettings): Promise<void>;
    };
    projects: {
      getProjects(): Promise<ProjectMetadata[]>;
      saveProjectInfo(project: Partial<ProjectMetadata> & { id: string }): Promise<ProjectMetadata>;
    };
  };
  open: (ownerId: string, place: FilePlace) => Promise<FileStore>;
  deployMinio?: ((ownerId: string, request: { name: string; clusterId: string }) => Promise<{ deploymentId: string }>) | undefined;
  defaultCluster: string;
  now?: (() => string) | undefined;
}

export type FileScope = { kind: 'project'; project: ProjectMetadata } | { kind: 'mine' };

export type PlaceState =
  | { state: 'ready'; place: FilePlace; server: FileServer; chosen: boolean }
  | { state: 'starting'; place: FilePlace; server: string }
  | { state: 'gone'; place: FilePlace; why: string }
  | { state: 'none' };

export type FilesOutcome<T> = { ok: true; value: T } | { ok: false; status: 400 | 404 | 409; why: string };

const STARTING = new Set(['deploying', 'pending', 'queued', 'provisioning']);

export class FileService {
  constructor(private readonly deps: FileServiceDeps) {}

  async servers(ownerId: string): Promise<{ servers: FileServer[]; defaultId?: string | undefined }> {
    const [deployments, settings] = await Promise.all([this.deps.store.infrastructure.getDeployments(), this.deps.store.files.getFileSettings(ownerId)]);
    const servers = fileServersOf(deployments, ownerId);
    const defaultId = settings?.deploymentId && servers.some((server) => server.deploymentId === settings.deploymentId) ? settings.deploymentId : undefined;
    return { servers, ...(defaultId ? { defaultId } : {}) };
  }

  async setDefault(ownerId: string, deploymentId: string | null): Promise<FilesOutcome<{ defaultId?: string | undefined }>> {
    if (deploymentId !== null && !(await this.servers(ownerId)).servers.some((server) => server.deploymentId === deploymentId)) {
      return { ok: false, status: 400, why: 'That is not one of your running file servers.' };
    }
    await this.deps.store.files.saveFileSettings({ ownerId, ...(deploymentId ? { deploymentId } : {}) });
    return { ok: true, value: deploymentId ? { defaultId: deploymentId } : {} };
  }

  async placeOf(ownerId: string, scope: FileScope): Promise<PlaceState> {
    const deployments = await this.deps.store.infrastructure.getDeployments();
    const servers = fileServersOf(deployments, ownerId);
    const recorded = scope.kind === 'project' ? scope.project.files : undefined;
    if (recorded) {
      const server = servers.find((entry) => entry.deploymentId === recorded.deploymentId);
      if (server) return { state: 'ready', place: recorded, server, chosen: true };
      const deployment = deployments.find((entry) => entry.id === recorded.deploymentId && entry.ownerId === ownerId);
      if (deployment && STARTING.has(deployment.status)) return { state: 'starting', place: recorded, server: deployment.name };
      return { state: 'gone', place: recorded, why: deployment ? `${deployment.name} is ${deployment.status}` : 'its file server was removed' };
    }
    const { defaultId } = await this.servers(ownerId);
    const server = servers.find((entry) => entry.deploymentId === defaultId);
    if (!server) return { state: 'none' };
    const folder = scope.kind === 'project' ? folderFor(scope.project.name) : PERSONAL_FOLDER;
    return { state: 'ready', place: { kind: server.kind, deploymentId: server.deploymentId, folder }, server, chosen: false };
  }

  async choose(ownerId: string, project: ProjectMetadata, deploymentId: string): Promise<FilesOutcome<PlaceState>> {
    const server = (await this.servers(ownerId)).servers.find((entry) => entry.deploymentId === deploymentId);
    if (!server) return { ok: false, status: 400, why: 'That is not one of your running file servers.' };
    const place: FilePlace = { kind: server.kind, deploymentId, folder: project.files?.folder ?? folderFor(project.name) };
    const saved = await this.deps.store.projects.saveProjectInfo({ id: project.id, files: place });
    return { ok: true, value: await this.placeOf(ownerId, { kind: 'project', project: saved }) };
  }

  async startMinio(ownerId: string, project: ProjectMetadata): Promise<FilesOutcome<PlaceState>> {
    const current = await this.placeOf(ownerId, { kind: 'project', project });
    if (current.state === 'ready' || current.state === 'starting') return { ok: true, value: current };
    if (!this.deps.deployMinio) return { ok: false, status: 409, why: 'A file server can only be started from the project\'s Settings.' };
    const taken = new Set((await this.deps.store.infrastructure.getDeployments()).map((entry) => entry.name));
    let name = FILES_APP_NAME;
    for (let n = 2; taken.has(name); n += 1) name = `${FILES_APP_NAME}-${n}`;
    const { deploymentId } = await this.deps.deployMinio(ownerId, { name, clusterId: project.targetClusterId ?? this.deps.defaultCluster });
    const place: FilePlace = { kind: 'minio', deploymentId, folder: project.files?.folder ?? folderFor(project.name) };
    const saved = await this.deps.store.projects.saveProjectInfo({ id: project.id, files: place });
    return { ok: true, value: await this.placeOf(ownerId, { kind: 'project', project: saved }) };
  }

  private async storeFor(ownerId: string, scope: FileScope): Promise<FilesOutcome<FileStore>> {
    const state = await this.placeOf(ownerId, scope);
    if (state.state === 'none') {
      return { ok: false, status: 409, why: scope.kind === 'project' ? 'This project has no file server yet.' : 'You have no default file server yet.' };
    }
    if (state.state === 'starting') return { ok: false, status: 409, why: `${state.server} is still starting.` };
    if (state.state === 'gone') return { ok: false, status: 409, why: `This project's files cannot be reached: ${state.why}.` };
    if (scope.kind === 'project' && !state.chosen) await this.deps.store.projects.saveProjectInfo({ id: scope.project.id, files: state.place });
    return { ok: true, value: await this.deps.open(ownerId, state.place) };
  }

  private async clientFilesOf(scope: FileScope): Promise<string[]> {
    if (scope.kind !== 'project') return [];
    return (await this.deps.store.projects.getProjects()).find((entry) => entry.id === scope.project.id)?.clientFiles ?? [];
  }

  private async keepClientFiles(scope: FileScope, next: (shared: string[]) => string[]): Promise<string[]> {
    if (scope.kind !== 'project') return [];
    const before = await this.clientFilesOf(scope);
    const after = next(before);
    if (JSON.stringify(after) !== JSON.stringify(before)) await this.deps.store.projects.saveProjectInfo({ id: scope.project.id, clientFiles: after });
    return after;
  }

  async list(ownerId: string, scope: FileScope, dir: string): Promise<FilesOutcome<(FileEntry & { forClients?: ClientMark })[]>> {
    const store = await this.storeFor(ownerId, scope);
    return store.ok ? { ok: true, value: marked(await store.value.list(dir), await this.clientFilesOf(scope)) } : store;
  }

  async clientFiles(scope: FileScope): Promise<string[]> {
    return this.clientFilesOf(scope);
  }

  async forClients(scope: FileScope, path: string, on: boolean): Promise<FilesOutcome<{ clientFiles: string[] }>> {
    if (scope.kind !== 'project') return { ok: false, status: 400, why: 'Only a project\'s files are shared with its clients.' };
    return { ok: true, value: { clientFiles: await this.keepClientFiles(scope, (shared) => sharing(shared, path, on)) } };
  }

  async download(ownerId: string, scope: FileScope, path: string): Promise<FilesOutcome<Download>> {
    const store = await this.storeFor(ownerId, scope);
    if (!store.ok) return store;
    const found = await store.value.download(path);
    return found ? { ok: true, value: found } : { ok: false, status: 404, why: `There is no file ${path}.` };
  }

  async upload(ownerId: string, scope: FileScope, path: string, body: Readable, size: number | undefined, contentType: string): Promise<FilesOutcome<{ path: string }>> {
    const store = await this.storeFor(ownerId, scope);
    if (!store.ok) return store;
    await store.value.upload(path, body, size, contentType);
    return { ok: true, value: { path } };
  }

  async remove(ownerId: string, scope: FileScope, path: string): Promise<FilesOutcome<{ path: string }>> {
    const store = await this.storeFor(ownerId, scope);
    if (!store.ok) return store;
    await store.value.remove(path);
    await this.keepClientFiles(scope, (shared) => afterRemove(shared, path));
    return { ok: true, value: { path } };
  }

  async move(ownerId: string, scope: FileScope, from: string, to: string): Promise<FilesOutcome<{ path: string }>> {
    const store = await this.storeFor(ownerId, scope);
    if (!store.ok) return store;
    await store.value.move(from, to);
    await this.keepClientFiles(scope, (shared) => afterMove(shared, from, to));
    return { ok: true, value: { path: to } };
  }

  async makeFolder(ownerId: string, scope: FileScope, path: string): Promise<FilesOutcome<{ path: string }>> {
    const store = await this.storeFor(ownerId, scope);
    if (!store.ok) return store;
    await store.value.makeFolder(path);
    return { ok: true, value: { path } };
  }

  async search(ownerId: string, scope: FileScope, query: string): Promise<FilesOutcome<(FileEntry & { forClients?: ClientMark })[]>> {
    if (!query.trim()) return { ok: true, value: [] };
    const store = await this.storeFor(ownerId, scope);
    return store.ok ? { ok: true, value: marked(await store.value.search(query), await this.clientFilesOf(scope)) } : store;
  }

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  async share(ownerId: string, scope: FileScope, path: string, days: ShareDays): Promise<FilesOutcome<FileShare>> {
    const found = await this.download(ownerId, scope, path);
    if (!found.ok) return found;
    found.value.stream.destroy();
    const now = this.now();
    const share: FileShare = {
      id: randomBytes(24).toString('base64url'),
      ownerId,
      ...(scope.kind === 'project' ? { projectId: scope.project.id } : {}),
      path,
      name: path.split('/').pop() ?? path,
      createdAt: now,
      expiresAt: shareExpires(now, days),
    };
    await this.deps.store.files.saveFileShare(share);
    return { ok: true, value: share };
  }

  async shares(ownerId: string): Promise<FileShare[]> {
    const now = this.now();
    return (await this.deps.store.files.getFileShares(ownerId)).filter((share) => shareLive(share, now));
  }

  async unshare(ownerId: string, id: string): Promise<FilesOutcome<{ id: string }>> {
    const share = await this.deps.store.files.getFileShare(id);
    if (!share || share.ownerId !== ownerId) return { ok: false, status: 404, why: 'There is no such link.' };
    await this.deps.store.files.deleteFileShare(id);
    return { ok: true, value: { id } };
  }

  async shared(token: string): Promise<FilesOutcome<Download & { name: string }>> {
    const gone = { ok: false as const, status: 404 as const, why: 'This link does not exist, or it has expired.' };
    if (!SHARE_TOKEN.test(token)) return gone;
    const share = await this.deps.store.files.getFileShare(token);
    if (!share) return gone;
    if (!shareLive(share, this.now())) {
      await this.deps.store.files.deleteFileShare(share.id);
      return gone;
    }
    const project = share.projectId ? (await this.deps.store.projects.getProjects()).find((entry) => entry.id === share.projectId && entry.ownerId === share.ownerId) : undefined;
    if (share.projectId && !project) return gone;
    const found = await this.download(share.ownerId, project ? { kind: 'project', project } : { kind: 'mine' }, share.path);
    return found.ok ? { ok: true, value: { ...found.value, name: share.name } } : gone;
  }

  async removeProjectFiles(ownerId: string, project: ProjectMetadata): Promise<'removed' | 'none' | 'unreachable'> {
    if (!project.files) return 'none';
    const state = await this.placeOf(ownerId, { kind: 'project', project });
    if (state.state !== 'ready') return 'unreachable';
    await (await this.deps.open(ownerId, state.place)).removeAll();
    return 'removed';
  }
}
