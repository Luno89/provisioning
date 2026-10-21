import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { FileService } from './FileService.js';
import type { FileStore } from './FileStores.js';
import type { DeploymentMetadata, ProjectMetadata } from '../lib/types.js';
import type { FilePlace, FileSettings } from '../lib/file-places.js';

const deployment = (over: Partial<DeploymentMetadata>): DeploymentMetadata => ({ id: 'm1', name: 'minio', appType: 'minio', status: 'running', clusterId: 'c1', ownerId: 'u1', minioRootPassword: 'pw', ...over } as DeploymentMetadata);

function setUp(deployments: DeploymentMetadata[], settings?: FileSettings) {
  const projects = new Map<string, ProjectMetadata>([['p1', { id: 'p1', name: 'Web Portal', appType: 'gitapp', ownerId: 'u1', createdAt: 'now' } as ProjectMetadata]]);
  const saved = settings ? new Map([[settings.ownerId, settings]]) : new Map<string, FileSettings>();
  const opened: FilePlace[] = [];
  const store: FileStore = {
    list: vi.fn(async () => [{ name: 'a.pdf', path: 'a.pdf', type: 'file' as const }]),
    download: vi.fn(async () => undefined),
    upload: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    move: vi.fn(async () => undefined),
    removeAll: vi.fn(async () => undefined),
  };
  const deployMinio = vi.fn(async () => {
    deployments.push(deployment({ id: 'new', name: 'koala-files', status: 'deploying', minioRootPassword: 'pw' }));
    return { deploymentId: 'new' };
  });
  const files = new FileService({
    store: {
      getDeployments: async () => deployments,
      getFileSettings: async (ownerId) => saved.get(ownerId),
      saveFileSettings: async (next) => { saved.set(next.ownerId, next); },
      saveProjectInfo: async (patch) => { const next = { ...projects.get(patch.id)!, ...patch } as ProjectMetadata; projects.set(patch.id, next); return next; },
    },
    open: async (_ownerId, place) => { opened.push(place); return store; },
    deployMinio,
    defaultCluster: 'system',
  });
  return { files, projects, store, opened, deployMinio, project: () => projects.get('p1')! };
}

describe('where a project\'s files go', () => {
  it('nowhere until the person has a server, then their default, in a folder named from the project once and kept', async () => {
    const none = setUp([]);
    expect(await none.files.placeOf('u1', { kind: 'project', project: none.project() })).toEqual({ state: 'none' });
    expect(await none.files.list('u1', { kind: 'project', project: none.project() }, '')).toEqual({ ok: false, status: 409, why: 'This project has no file server yet.' });

    const world = setUp([deployment({})], { ownerId: 'u1', deploymentId: 'm1' });
    expect(await world.files.placeOf('u1', { kind: 'project', project: world.project() })).toMatchObject({ state: 'ready', chosen: false, place: { kind: 'minio', deploymentId: 'm1', folder: 'web-portal' } });
    await world.files.list('u1', { kind: 'project', project: world.project() }, '');
    expect(world.project().files).toEqual({ kind: 'minio', deploymentId: 'm1', folder: 'web-portal' });
    await world.files.choose('u1', { ...world.project(), name: 'Renamed' }, 'm1');
    expect(world.project().files?.folder).toBe('web-portal');
  });

  it('takes only the person\'s own running servers as a default or a project\'s choice', async () => {
    const world = setUp([deployment({}), deployment({ id: 'theirs', ownerId: 'u2' })]);
    expect(await world.files.setDefault('u1', 'theirs')).toMatchObject({ ok: false, status: 400 });
    expect(await world.files.choose('u1', world.project(), 'theirs')).toMatchObject({ ok: false, status: 400 });
    expect(await world.files.setDefault('u1', 'm1')).toEqual({ ok: true, value: { defaultId: 'm1' } });
    expect(await world.files.servers('u1')).toEqual({ servers: [{ kind: 'minio', deploymentId: 'm1', name: 'minio', clusterId: 'c1' }], defaultId: 'm1' });
  });

  it('starts a MinIO on the project\'s cluster when it has none, waits while it starts, then stores there', async () => {
    const deployments = [deployment({ id: 'other', name: 'koala-files', ownerId: 'u2' })];
    const world = setUp(deployments);
    const started = await world.files.startMinio('u1', { ...world.project(), targetClusterId: 'mine' });
    expect(world.deployMinio).toHaveBeenCalledWith('u1', { name: 'koala-files-2', clusterId: 'mine' });
    expect(started).toEqual({ ok: true, value: { state: 'starting', place: { kind: 'minio', deploymentId: 'new', folder: 'web-portal' }, server: 'koala-files' } });
    expect(await world.files.upload('u1', { kind: 'project', project: world.project() }, 'a.pdf', Readable.from([]), 0, 'application/pdf')).toEqual({ ok: false, status: 409, why: 'koala-files is still starting.' });
    deployments.find((entry) => entry.id === 'new')!.status = 'running';
    expect(await world.files.upload('u1', { kind: 'project', project: world.project() }, 'a.pdf', Readable.from([]), 0, 'application/pdf')).toEqual({ ok: true, value: { path: 'a.pdf' } });
    expect(world.opened.at(-1)).toEqual({ kind: 'minio', deploymentId: 'new', folder: 'web-portal' });
    await world.files.startMinio('u1', world.project());
    expect(world.deployMinio).toHaveBeenCalledOnce();
  });

  it('says plainly when a project\'s server is gone, and removes a project\'s files only where it can reach them', async () => {
    const deployments = [deployment({})];
    const world = setUp(deployments);
    await world.files.choose('u1', world.project(), 'm1');
    expect(await world.files.removeProjectFiles('u1', world.project())).toBe('removed');
    expect(world.store.removeAll).toHaveBeenCalledOnce();
    deployments[0]!.status = 'failed';
    expect(await world.files.placeOf('u1', { kind: 'project', project: world.project() })).toEqual({ state: 'gone', place: { kind: 'minio', deploymentId: 'm1', folder: 'web-portal' }, why: 'minio is failed' });
    expect(await world.files.removeProjectFiles('u1', world.project())).toBe('unreachable');
  });

  it('keeps a person\'s own files, outside any project, in their default server\'s personal folder', async () => {
    const world = setUp([deployment({})], { ownerId: 'u1', deploymentId: 'm1' });
    await world.files.list('u1', { kind: 'mine' }, 'chats/c1');
    expect(world.opened.at(-1)).toEqual({ kind: 'minio', deploymentId: 'm1', folder: 'personal' });
  });
});
