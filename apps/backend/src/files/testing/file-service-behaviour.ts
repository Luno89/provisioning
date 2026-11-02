import { matching } from '../../platform/lib/test-matchers.js';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { FileService } from '../services/FileService.js';
import type { FileStore } from '../services/FileStores.js';
import type { Database } from '../../platform/lib/db-interface.js';
import type { DeploymentMetadata, ProjectMetadata } from '../../platform/lib/types.js';
import type { FilePlace, FileSettings } from '../lib/file-places.js';

const deployment = (over: Partial<DeploymentMetadata>): DeploymentMetadata => ({ id: 'm1', name: 'minio', appType: 'minio', status: 'running', clusterId: 'c1', ownerId: 'u1', minioRootPassword: 'pw', strategy: 'native', ...over } as DeploymentMetadata);

const clock = { now: '2026-10-21T10:00:00.000Z' };

async function setUp(db: Database, deployments: DeploymentMetadata[], settings?: FileSettings) {
  for (const entry of deployments) await db.infrastructure.saveDeployment(entry);
  await db.projects.saveProject({ id: 'p1', name: 'Web Portal', appType: 'gitapp', giteaOwner: 'u1', giteaRepo: 'web-portal', ownerId: 'u1', createdAt: 'now' } as ProjectMetadata);
  if (settings) await db.files.saveFileSettings(settings);
  const opened: FilePlace[] = [];
  const kept = new Map<string, Buffer>([['a.pdf', Buffer.from('%PDF')]]);
  const store: FileStore = {
    list: vi.fn(async () => [{ name: 'a.pdf', path: 'a.pdf', type: 'file' as const }]),
    search: vi.fn(async () => [{ name: 'a.pdf', path: 'a.pdf', type: 'file' as const }]),
    makeFolder: vi.fn(async () => undefined),
    download: vi.fn(async (path: string) => (kept.has(path) ? { stream: Readable.from([kept.get(path)!]), size: kept.get(path)!.length, contentType: 'application/pdf', etag: createHash('md5').update(kept.get(path)!).digest('hex') } : undefined)),
    upload: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    move: vi.fn(async () => undefined),
    removeAll: vi.fn(async () => undefined),
  };
  const deployMinio = vi.fn(async () => {
    await db.infrastructure.saveDeployment(deployment({ id: 'new', name: 'koala-files', status: 'deploying', minioRootPassword: 'pw' }));
    return { deploymentId: 'new' };
  });
  const files = new FileService({
    store: db,
    open: async (_ownerId, place) => { opened.push(place); return store; },
    deployMinio,
    defaultCluster: 'system',
    now: () => clock.now,
  });
  const project = async () => (await db.projects.getProjects()).find((entry) => entry.id === 'p1')!;
  const setStatus = async (id: string, status: string) => {
    const found = (await db.infrastructure.getDeployments()).find((entry) => entry.id === id)!;
    await db.infrastructure.saveDeployment({ ...found, status } as DeploymentMetadata);
  };
  return { files, store, opened, deployMinio, kept, project, setStatus, shares: (ownerId: string) => db.files.getFileShares(ownerId), share: (id: string) => db.files.getFileShare(id), saveShare: (share: Parameters<Database['files']['saveFileShare']>[0]) => db.files.saveFileShare(share) };
}

type World = Awaited<ReturnType<typeof setUp>>;

export function fileServiceBehaviour(make: () => Promise<Database>): void {
  const world = async (deployments: DeploymentMetadata[], settings?: FileSettings) => setUp(await make(), deployments, settings);
  const inProject = async (w: World) => ({ kind: 'project' as const, project: await w.project() });

  describe('where a project\'s files go', () => {
    it('nowhere until the person has a server, then their default, in a folder named from the project once and kept', async () => {
      const none = await world([]);
      expect(await none.files.placeOf('u1', await inProject(none))).toEqual({ state: 'none' });
      expect(await none.files.list('u1', await inProject(none), '')).toEqual({ ok: false, status: 409, why: 'This project has no file server yet.' });

      const ready = await world([deployment({})], { ownerId: 'u1', deploymentId: 'm1' });
      expect(await ready.files.placeOf('u1', await inProject(ready))).toMatchObject({ state: 'ready', chosen: false, place: { kind: 'minio', deploymentId: 'm1', folder: 'web-portal' } });
      await ready.files.list('u1', await inProject(ready), '');
      expect((await ready.project()).files).toEqual({ kind: 'minio', deploymentId: 'm1', folder: 'web-portal' });
      await ready.files.choose('u1', { ...(await ready.project()), name: 'Renamed' }, 'm1');
      expect((await ready.project()).files?.folder).toBe('web-portal');
    });

    it('takes only the person\'s own running servers as a default or a project\'s choice', async () => {
      const w = await world([deployment({}), deployment({ id: 'theirs', ownerId: 'u2' })]);
      expect(await w.files.setDefault('u1', 'theirs')).toMatchObject({ ok: false, status: 400 });
      expect(await w.files.choose('u1', await w.project(), 'theirs')).toMatchObject({ ok: false, status: 400 });
      expect(await w.files.setDefault('u1', 'm1')).toEqual({ ok: true, value: { defaultId: 'm1' } });
      expect(await w.files.servers('u1')).toEqual({ servers: [{ kind: 'minio', deploymentId: 'm1', name: 'minio', clusterId: 'c1' }], defaultId: 'm1' });
    });

    it('starts a MinIO on the project\'s cluster when it has none, waits while it starts, then stores there', async () => {
      const w = await world([deployment({ id: 'other', name: 'koala-files', ownerId: 'u2' })]);
      const started = await w.files.startMinio('u1', { ...(await w.project()), targetClusterId: 'mine' });
      expect(w.deployMinio).toHaveBeenCalledWith('u1', { name: 'koala-files-2', clusterId: 'mine' });
      expect(started).toEqual({ ok: true, value: { state: 'starting', place: { kind: 'minio', deploymentId: 'new', folder: 'web-portal' }, server: 'koala-files' } });
      expect((await w.project()).files).toEqual({ kind: 'minio', deploymentId: 'new', folder: 'web-portal' });
      expect(await w.files.upload('u1', await inProject(w), 'a.pdf', Readable.from([]), 0, 'application/pdf')).toEqual({ ok: false, status: 409, why: 'koala-files is still starting.' });
      await w.setStatus('new', 'running');
      expect(await w.files.upload('u1', await inProject(w), 'a.pdf', Readable.from([]), 0, 'application/pdf')).toEqual({ ok: true, value: { path: 'a.pdf' } });
      expect(w.opened.at(-1)).toEqual({ kind: 'minio', deploymentId: 'new', folder: 'web-portal' });
      await w.files.startMinio('u1', await w.project());
      expect(w.deployMinio).toHaveBeenCalledOnce();
    });

    it('refuses to start a file server where none can be deployed, and starts none for a project that already has one', async () => {
      const db = await make();
      await db.projects.saveProject({ id: 'p1', name: 'Web Portal', appType: 'gitapp', giteaOwner: 'u1', giteaRepo: 'web-portal', ownerId: 'u1', createdAt: 'now' } as ProjectMetadata);
      const files = new FileService({ store: db, open: async () => { throw new Error('nothing to open'); }, defaultCluster: 'system', now: () => clock.now });
      const project = (await db.projects.getProjects())[0]!;
      expect(await files.startMinio('u1', project)).toEqual({ ok: false, status: 409, why: 'A file server can only be started from the project\'s Settings.' });
      expect(await db.infrastructure.getDeployments()).toEqual([]);
    });

    it('says plainly when a project\'s server is gone, and removes a project\'s files only where it can reach them', async () => {
      const w = await world([deployment({})]);
      await w.files.choose('u1', await w.project(), 'm1');
      expect(await w.files.removeProjectFiles('u1', await w.project())).toBe('removed');
      expect(w.store.removeAll).toHaveBeenCalledOnce();
      await w.setStatus('m1', 'failed');
      expect(await w.files.placeOf('u1', await inProject(w))).toEqual({ state: 'gone', place: { kind: 'minio', deploymentId: 'm1', folder: 'web-portal' }, why: 'minio is failed' });
      expect(await w.files.removeProjectFiles('u1', await w.project())).toBe('unreachable');
    });

    it('removes nothing for a project that never kept files, and leaves a folder another project of the person still uses', async () => {
      const db = await make();
      const w = await setUp(db, [deployment({})], { ownerId: 'u1', deploymentId: 'm1' });
      expect(await w.files.removeProjectFiles('u1', await w.project())).toBe('none');
      await w.files.choose('u1', await w.project(), 'm1');
      await db.projects.saveProject({ id: 'p2', name: 'Web Portal Twin', appType: 'gitapp', giteaOwner: 'u1', giteaRepo: 'twin', ownerId: 'u1', createdAt: 'now', files: { kind: 'minio', deploymentId: 'm1', folder: 'web-portal' } } as ProjectMetadata);
      expect(await w.files.removeProjectFiles('u1', await w.project())).toBe('shared');
      expect(w.store.removeAll).not.toHaveBeenCalled();
    });

    it('keeps a person\'s own files, outside any project, in their default server\'s personal folder', async () => {
      const w = await world([deployment({})], { ownerId: 'u1', deploymentId: 'm1' });
      await w.files.list('u1', { kind: 'mine' }, 'chats/c1');
      expect(w.opened.at(-1)).toEqual({ kind: 'minio', deploymentId: 'm1', folder: 'personal' });
    });

    it('shares one file by a link that serves it to anyone until it expires, and only the person can see or revoke it', async () => {
      clock.now = '2026-10-21T10:00:00.000Z';
      const w = await world([deployment({})]);
      await w.files.choose('u1', await w.project(), 'm1');
      const scope = await inProject(w);
      expect(await w.files.share('u1', scope, 'nope.pdf', 7)).toMatchObject({ ok: false, status: 404 });
      const made = await w.files.share('u1', scope, 'a.pdf', 1);
      if (!made.ok) throw new Error(made.why);
      expect(made.value).toMatchObject({ ownerId: 'u1', projectId: 'p1', path: 'a.pdf', name: 'a.pdf', expiresAt: '2026-10-22T10:00:00.000Z' });
      expect(made.value.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(made.value.id).not.toBe(made.value.token);
      expect(await w.files.shared(made.value.id)).toMatchObject({ ok: false, status: 404 });
      const served = await w.files.shared(made.value.token);
      expect(served).toMatchObject({ ok: true, value: { name: 'a.pdf', contentType: 'application/pdf' } });
      expect((await w.files.shares('u1')).map((share) => share.id)).toEqual([made.value.id]);
      expect(await w.files.shares('u2')).toEqual([]);
      expect(await w.files.unshare('u2', made.value.id)).toMatchObject({ ok: false, status: 404 });

      clock.now = '2026-10-22T10:00:01.000Z';
      expect(await w.files.shared(made.value.token)).toMatchObject({ ok: false, status: 404 });
      expect(await w.shares('u1')).toEqual([]);
      expect(await w.files.shared('../../etc/passwd')).toMatchObject({ ok: false, status: 404 });
    });

    it('opens the file a link was made for and nothing else, so a file put at that path later is never served by it', async () => {
      clock.now = '2026-10-21T10:00:00.000Z';
      const w = await world([deployment({})]);
      await w.files.choose('u1', await w.project(), 'm1');
      const made = await w.files.share('u1', await inProject(w), 'a.pdf', 7);
      if (!made.ok) throw new Error(made.why);
      expect(made.value.etag).toMatch(/^[0-9a-f]{32}$/);
      expect(await w.files.shared(made.value.token)).toMatchObject({ ok: true });
      w.kept.set('a.pdf', Buffer.from('%PDF a different file put at the same name'));
      expect(await w.files.shared(made.value.token)).toMatchObject({ ok: false, status: 404, why: matching(/replaced or removed/) });
    });

    it('ties a link made before links were tied to the file it opens first', async () => {
      clock.now = '2026-10-21T10:00:00.000Z';
      const w = await world([deployment({})]);
      await w.files.choose('u1', await w.project(), 'm1');
      const made = await w.files.share('u1', await inProject(w), 'a.pdf', 7);
      if (!made.ok) throw new Error(made.why);
      const { etag: _etag, ...before } = made.value;
      await w.saveShare(before);
      expect((await w.share(made.value.id))?.etag).toBeUndefined();
      expect(await w.files.shared(made.value.token)).toMatchObject({ ok: true });
      expect((await w.share(made.value.id))?.etag).toMatch(/^[0-9a-f]{32}$/);
      w.kept.set('a.pdf', Buffer.from('replaced'));
      expect(await w.files.shared(made.value.token)).toMatchObject({ ok: false, status: 404 });
    });
  });

  describe('changing the files in a place', () => {
    it('removes a file or folder and says which path went', async () => {
      const w = await world([deployment({})], { ownerId: 'u1', deploymentId: 'm1' });
      expect(await w.files.remove('u1', await inProject(w), 'docs/a.pdf')).toEqual({ ok: true, value: { path: 'docs/a.pdf' } });
      expect(w.store.remove).toHaveBeenCalledWith('docs/a.pdf');
    });

    it('moves a file or folder and says where it went', async () => {
      const w = await world([deployment({})], { ownerId: 'u1', deploymentId: 'm1' });
      expect(await w.files.move('u1', await inProject(w), 'a.pdf', 'docs/a.pdf')).toEqual({ ok: true, value: { path: 'docs/a.pdf' } });
      expect(w.store.move).toHaveBeenCalledWith('a.pdf', 'docs/a.pdf');
    });

    it('makes an empty folder', async () => {
      const w = await world([deployment({})], { ownerId: 'u1', deploymentId: 'm1' });
      expect(await w.files.makeFolder('u1', { kind: 'mine' }, 'chats')).toEqual({ ok: true, value: { path: 'chats' } });
      expect(w.store.makeFolder).toHaveBeenCalledWith('chats');
      expect(w.opened.at(-1)).toEqual({ kind: 'minio', deploymentId: 'm1', folder: 'personal' });
    });

    it('searches the place by name, and answers an empty search without opening it', async () => {
      const w = await world([deployment({})], { ownerId: 'u1', deploymentId: 'm1' });
      expect(await w.files.search('u1', await inProject(w), 'pdf')).toEqual({ ok: true, value: [{ name: 'a.pdf', path: 'a.pdf', type: 'file' }] });
      expect(w.store.search).toHaveBeenCalledWith('pdf');
      expect(await w.files.search('u1', await inProject(w), '   ')).toEqual({ ok: true, value: [] });
      expect(w.store.search).toHaveBeenCalledOnce();
    });

    it('refuses every change while the person has no file server, and touches nothing', async () => {
      const w = await world([]);
      const scope = await inProject(w);
      const none = { ok: false, status: 409, why: 'This project has no file server yet.' };
      expect(await w.files.remove('u1', scope, 'a.pdf')).toEqual(none);
      expect(await w.files.move('u1', scope, 'a.pdf', 'b.pdf')).toEqual(none);
      expect(await w.files.makeFolder('u1', scope, 'docs')).toEqual(none);
      expect(await w.files.search('u1', scope, 'pdf')).toEqual(none);
      expect(w.store.remove).not.toHaveBeenCalled();
      expect(w.store.move).not.toHaveBeenCalled();
      expect(w.store.makeFolder).not.toHaveBeenCalled();
      expect(w.store.search).not.toHaveBeenCalled();
    });
  });
}
