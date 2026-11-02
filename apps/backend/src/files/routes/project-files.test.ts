import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import type { Socket } from 'socket.io';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { any, matches, mock } from 'vitest-mock-extended';
import { registerDevice, unregisterDevice } from '../../machines/lib/local-agent-registry.js';
import { anyOf } from '../../platform/lib/test-matchers.js';
import type { ProjectMetadata } from '../../platform/lib/types.js';
import { GiteaConflictError } from '../../projects/services/GiteaService.js';
import { TEST_USER } from '../../platform/routes/test-harness.js';
import { routesInProcess } from '../../platform/testing/routes.js';
import { DROP_TYPE, dropBody, type DroppedFile } from '../lib/drops.js';
import { projectFilesRouter, type ProjectFilesRouterDeps } from './project-files.js';

const repoProject = { id: 'proj-1', name: 'demo', giteaOwner: 'acme', giteaRepo: 'demo', ownerId: TEST_USER.id, appType: 'gitapp' } as ProjectMetadata;
const deviceProject = { id: 'proj-device', name: 'machine project', ownerId: TEST_USER.id, appType: 'local', executionTarget: { kind: 'local-device', deviceId: 'dev-1' } } as ProjectMetadata;
const inFolder = { ...deviceProject, id: 'proj-folder', executionTarget: { kind: 'local-device', deviceId: 'dev-1', path: 'work' } } as ProjectMetadata;
const bare = { id: 'proj-bare', name: 'bare', ownerId: TEST_USER.id, appType: 'gitapp' } as ProjectMetadata;
const ownerless = { id: 'proj-ownerless', name: 'ownerless', appType: 'gitapp' } as ProjectMetadata;

async function setUp() {
  const projectRepoService = mock<ProjectFilesRouterDeps['projectRepoService']>();
  const giteaService = mock<ProjectFilesRouterDeps['giteaService']>();
  const drops = mock<ProjectFilesRouterDeps['drops']>();
  const storyDrops = mock<ProjectFilesRouterDeps['storyDrops']>();
  const deps = mock<ProjectFilesRouterDeps>({ projectRepoService, giteaService, drops, storyDrops });
  for (const project of [repoProject, deviceProject, inFolder, bare, ownerless]) deps.getOwnedProject.calledWith(project.id, any()).mockResolvedValue(project);
  deps.getOwnedProject.calledWith('ghost', any()).mockResolvedValue(undefined);
  projectRepoService.editorCredential.calledWith(TEST_USER.id).mockResolvedValue({ token: 'tok-1', username: 'acme' });
  const routes = await routesInProcess({ prefix: '/', router: () => projectFilesRouter(deps) });
  return { projectRepoService, giteaService, drops, storyDrops, routes };
}

const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

const connected: Socket[] = [];
afterEach(() => {
  for (const socket of connected.splice(0)) unregisterDevice('dev-1', socket);
});

function deviceAnswering(answer: (event: string, payload: unknown) => unknown) {
  const socket = mock<Socket>();
  socket.connected = true;
  const seen: { event: string; payload: unknown }[] = [];
  socket.emit.mockImplementation(((event: string, payload: unknown, ack: (reply?: unknown) => void) => {
    seen.push({ event, payload });
    ack(answer(event, payload));
    return true;
  }) as never);
  registerDevice('dev-1', TEST_USER.id, '/x', socket);
  connected.push(socket);
  return seen;
}

describe('GET /:id/files', () => {
  it('lists a directory using a per-user editor token', async () => {
    const { giteaService, routes } = await setUp();
    giteaService.listDirectory.mockResolvedValue([{ path: 'src', name: 'src', type: 'dir' }]);
    const res = await routes.get('/proj-1/files');
    expect(res.data).toEqual({ path: '', entries: [{ path: 'src', name: 'src', type: 'dir' }] });
    expect(giteaService.listDirectory).toHaveBeenCalledWith('tok-1', 'acme', 'demo', '', undefined);
  });

  it('lists a branch of a directory when a ref is asked for', async () => {
    const { giteaService, routes } = await setUp();
    giteaService.listDirectory.mockResolvedValue([]);
    await routes.get('/proj-1/files?path=src&ref=story-1');
    expect(giteaService.listDirectory).toHaveBeenCalledWith('tok-1', 'acme', 'demo', 'src', 'story-1');
  });

  it('refuses a path that escapes the repo, a project owned by someone else, and a project with no repository', async () => {
    const { routes } = await setUp();
    expect((await routes.get('/proj-1/files?path=../etc')).status).toBe(400);
    expect((await routes.get('/ghost/files')).status).toBe(404);
    expect((await routes.get('/ownerless/files')).status).toBe(404);
    const none = await routes.get('/proj-bare/files');
    expect([none.status, none.data]).toEqual([409, { error: 'this project has no repository' }]);
  });

  it('lists a directory over the local-agent connection, not Gitea', async () => {
    const { giteaService, routes } = await setUp();
    const seen = deviceAnswering(() => ({ entries: [{ name: 'index.ts', path: 'src/index.ts', type: 'file' }] }));
    const res = await routes.get('/proj-device/files?path=src');
    expect(res.data).toEqual({ path: 'src', entries: [{ name: 'index.ts', path: 'src/index.ts', type: 'file' }] });
    expect(seen).toEqual([{ event: 'sandbox:listDir', payload: { path: 'src' } }]);
    expect(giteaService.listDirectory).not.toHaveBeenCalled();
  });

  it('lists inside the folder the machine project was given', async () => {
    const { routes } = await setUp();
    const seen = deviceAnswering(() => ({ entries: [] }));
    await routes.get('/proj-folder/files?path=src');
    expect(seen[0]?.payload).toEqual({ path: 'work/src' });
  });
});

describe('GET /:id/files/content', () => {
  it('returns the file content and sha', async () => {
    const { giteaService, routes } = await setUp();
    giteaService.getFileContent.mockResolvedValue({ path: 'README.md', content: '# hi', sha: 'abc123' });
    const res = await routes.get('/proj-1/files/content?path=README.md&ref=main');
    expect(res.data).toEqual({ path: 'README.md', content: '# hi', sha: 'abc123' });
    expect(giteaService.getFileContent).toHaveBeenCalledWith('tok-1', 'acme', 'demo', 'README.md', 'main');
  });

  it('404s a missing file, refuses an empty path, and says a project with no repository has none', async () => {
    const { giteaService, routes } = await setUp();
    giteaService.getFileContent.mockResolvedValue(null);
    expect((await routes.get('/proj-1/files/content?path=ghost.md')).status).toBe(404);
    expect((await routes.get('/proj-1/files/content')).status).toBe(400);
    expect((await routes.get('/ghost/files/content?path=a')).status).toBe(404);
    expect((await routes.get('/proj-bare/files/content?path=a')).status).toBe(409);
  });

  it('reads a file from the machine and derives a sha from it', async () => {
    const { routes } = await setUp();
    deviceAnswering(() => ({ content: '# hi' }));
    const res = await routes.get('/proj-device/files/content?path=README.md');
    expect(res.data).toEqual({ path: 'README.md', content: '# hi', sha: sha256('# hi') });
  });

  it('404s a file that does not exist on the machine', async () => {
    const { routes } = await setUp();
    deviceAnswering(() => ({ error: 'ENOENT: no such file or directory' }));
    expect((await routes.get('/proj-device/files/content?path=ghost.md')).status).toBe(404);
  });

  it('passes on any other failure of the machine', async () => {
    const { routes } = await setUp();
    deviceAnswering(() => ({ error: 'EACCES: permission denied' }));
    const res = await routes.get('/proj-device/files/content?path=secret.md');
    expect([res.status, res.data]).toEqual([500, { error: 'EACCES: permission denied' }]);
  });
});

describe('PUT /:id/files/content', () => {
  it('saves with the given sha and a default message', async () => {
    const { giteaService, routes } = await setUp();
    giteaService.updateFile.mockResolvedValue({ sha: 'def456' } as never);
    const res = await routes.put('/proj-1/files/content', { path: 'src/index.ts', content: 'export {}', sha: 'abc123' });
    expect(res.data).toEqual({ sha: 'def456' });
    expect(giteaService.updateFile).toHaveBeenCalledWith('tok-1', 'acme', 'demo', 'src/index.ts', 'export {}', 'Update src/index.ts', 'abc123', undefined);
  });

  it('saves with the message and branch it was given', async () => {
    const { giteaService, routes } = await setUp();
    giteaService.updateFile.mockResolvedValue({ sha: 'def456' } as never);
    await routes.put('/proj-1/files/content', { path: 'a.ts', content: 'x', sha: 's', message: '  Fix a  ', ref: 'story-1' });
    expect(giteaService.updateFile).toHaveBeenCalledWith('tok-1', 'acme', 'demo', 'a.ts', 'x', 'Fix a', 's', 'story-1');
  });

  it('requires a path inside the repository, content and a sha', async () => {
    const { giteaService, routes } = await setUp();
    const put = (json: unknown) => routes.put('/proj-1/files/content', json);
    expect((await put({ path: '../a.ts', content: 'x', sha: 's' })).status).toBe(400);
    expect((await put({ content: 'x', sha: 's' })).status).toBe(400);
    expect((await put({ path: 'a.ts', sha: 's' })).status).toBe(400);
    expect((await put({ path: 'a.ts', content: 'x' })).status).toBe(400);
    expect(giteaService.updateFile).not.toHaveBeenCalled();
  });

  it('surfaces a stale sha as a 409, not a 500, and anything else as it is', async () => {
    const { giteaService, routes } = await setUp();
    giteaService.updateFile.mockRejectedValueOnce(new GiteaConflictError('changed since it was loaded')).mockRejectedValueOnce(new Error('gitea is down'));
    const body = { path: 'a.ts', content: 'x', sha: 'stale' };
    const stale = await routes.put('/proj-1/files/content', body);
    expect([stale.status, stale.data]).toEqual([409, { error: 'changed since it was loaded' }]);
    expect((await routes.put('/proj-1/files/content', body)).status).toBe(500);
    expect((await routes.put('/proj-bare/files/content', body)).status).toBe(409);
    expect((await routes.put('/ghost/files/content', body)).status).toBe(404);
  });

  it('writes a file to the machine when the sha matches what is there', async () => {
    const { routes } = await setUp();
    const seen = deviceAnswering((event) => (event === 'sandbox:readFile' ? { content: 'old' } : undefined));
    const res = await routes.put('/proj-device/files/content', { path: 'a.ts', content: 'new', sha: sha256('old') });
    expect(res.data).toEqual({ sha: sha256('new') });
    expect(seen.at(-1)).toEqual({ event: 'sandbox:writeFile', payload: { leafId: anyOf(String), path: 'a.ts', content: 'new' } });
  });

  it('writes a file that is not there yet, and refuses one that changed on the machine', async () => {
    const { routes } = await setUp();
    deviceAnswering((event) => (event === 'sandbox:readFile' ? { error: 'ENOENT: no such file or directory' } : undefined));
    expect((await routes.put('/proj-device/files/content', { path: 'a.ts', content: 'new', sha: 'whatever' })).status).toBe(200);
    unregisterDevice('dev-1', connected[0]!);
    deviceAnswering(() => ({ content: 'changed on disk' }));
    const stale = await routes.put('/proj-device/files/content', { path: 'a.ts', content: 'new', sha: 'stale-sha' });
    expect([stale.status, stale.data]).toEqual([409, { error: '"a.ts" changed since it was loaded — reload and try again.' }]);
  });
});

describe('DELETE /:id/files/content', () => {
  it('deletes with the given sha', async () => {
    const { giteaService, routes } = await setUp();
    const res = await routes.delete('/proj-1/files/content?path=old.ts&sha=abc123&ref=story-1');
    expect(res.data).toEqual({ success: true });
    expect(giteaService.deleteFile).toHaveBeenCalledWith('tok-1', 'acme', 'demo', 'old.ts', 'Delete old.ts', 'abc123', 'story-1');
  });

  it('requires a path inside the repository and a sha', async () => {
    const { giteaService, routes } = await setUp();
    expect((await routes.delete('/proj-1/files/content?path=../old.ts&sha=s')).status).toBe(400);
    expect((await routes.delete('/proj-1/files/content?path=old.ts')).status).toBe(400);
    expect((await routes.delete('/ghost/files/content?path=old.ts&sha=s')).status).toBe(404);
    expect((await routes.delete('/proj-bare/files/content?path=old.ts&sha=s')).status).toBe(409);
    expect(giteaService.deleteFile).not.toHaveBeenCalled();
  });

  it('surfaces a stale sha as a 409, and anything else as it is', async () => {
    const { giteaService, routes } = await setUp();
    giteaService.deleteFile.mockRejectedValueOnce(new GiteaConflictError('changed since it was loaded')).mockRejectedValueOnce(new Error('gitea is down'));
    expect((await routes.delete('/proj-1/files/content?path=old.ts&sha=stale')).status).toBe(409);
    expect((await routes.delete('/proj-1/files/content?path=old.ts&sha=stale')).status).toBe(500);
  });

  it('deletes a file on the machine when the sha matches', async () => {
    const { routes } = await setUp();
    const seen = deviceAnswering((event) => (event === 'sandbox:readFile' ? { content: 'bye' } : undefined));
    const res = await routes.delete(`/proj-device/files/content?path=old.ts&sha=${sha256('bye')}`);
    expect(res.data).toEqual({ success: true });
    expect(seen.at(-1)).toEqual({ event: 'sandbox:deleteFile', payload: { path: 'old.ts' } });
  });

  it('refuses to delete a file that no longer exists on the machine or that changed there, 409', async () => {
    const { routes } = await setUp();
    deviceAnswering(() => ({ error: 'ENOENT: no such file or directory' }));
    const gone = await routes.delete('/proj-device/files/content?path=old.ts&sha=abc123');
    expect([gone.status, gone.data]).toEqual([409, { error: '"old.ts" no longer exists.' }]);
    unregisterDevice('dev-1', connected[0]!);
    deviceAnswering(() => ({ content: 'changed' }));
    expect((await routes.delete('/proj-device/files/content?path=old.ts&sha=abc123')).status).toBe(409);
  });
});

describe('POST /:id/files/drop', () => {
  const headers = { 'content-type': DROP_TYPE };

  it('commits what was dropped under the folder it was dropped on, with its bytes intact', async () => {
    const { drops, routes } = await setUp();
    const got: { path: string; bytes: Buffer; source: string }[] = [];
    drops.drop.mockImplementation(async (_project, files) => {
      for (const file of files) got.push({ path: file.path, source: file.source, bytes: await readFile(file.source) });
      return { ok: true, paths: files.map((file) => file.path), commit: 'c1' } as never;
    });
    const png = Buffer.from(Array.from({ length: 200_000 }, (_, index) => (index * 13) % 256));
    const body = dropBody({ dir: 'public', ref: 'story-1' }, [{ path: 'logo.png', bytes: png }]);
    const pieces = Readable.from(Array.from({ length: Math.ceil(body.length / 1000) }, (_, index) => body.subarray(index * 1000, (index + 1) * 1000)));
    const res = await routes.post('/proj-1/files/drop', undefined, { raw: pieces, headers });
    expect(res.status).toBe(201);
    expect(res.data).toEqual({ ok: true, paths: ['public/logo.png'], commit: 'c1' });
    expect(drops.drop).toHaveBeenCalledWith(repoProject, matches<readonly DroppedFile[]>((files) => files.length === 1 && files[0]?.path === 'public/logo.png' && files[0].size === png.length), { ref: 'story-1', message: undefined });
    expect(got.map((file) => [file.path, file.bytes])).toEqual([['public/logo.png', png]]);
    await vi.waitFor(() => expect(existsSync(got[0]!.source)).toBe(false));
  });

  it('says why the drop was refused, and a conflict as a 409', async () => {
    const { drops, routes } = await setUp();
    const body = dropBody({}, [{ path: 'x', bytes: Buffer.from('x') }]);
    drops.drop.mockResolvedValueOnce({ ok: false, why: 'x is a folder' } as never).mockRejectedValueOnce(new GiteaConflictError('main moved')).mockRejectedValueOnce(new Error('gitea is down'));
    const folder = await routes.post('/proj-1/files/drop', undefined, { raw: body, headers });
    expect([folder.status, folder.data]).toEqual([409, { error: 'x is a folder' }]);
    const moved = await routes.post('/proj-1/files/drop', undefined, { raw: body, headers });
    expect([moved.status, moved.data]).toEqual([409, { error: 'main moved' }]);
    expect((await routes.post('/proj-1/files/drop', undefined, { raw: body, headers })).status).toBe(500);
  });

  it('refuses a file that would land outside the repository, a drop into someone else\'s project, and a drop sent as anything else', async () => {
    const { drops, routes } = await setUp();
    const outside = await routes.post('/proj-1/files/drop', undefined, { raw: dropBody({}, [{ path: '../x', bytes: Buffer.from('x') }]), headers });
    expect([outside.status, outside.data]).toEqual([400, { error: '../x would land outside the repository' }]);
    const missing = await routes.post('/ghost/files/drop', undefined, { raw: dropBody({}, [{ path: 'x', bytes: Buffer.from('x') }]), headers });
    expect(missing.status).toBe(404);
    const json = await routes.post('/proj-1/files/drop', { files: [] });
    expect(json.status).toBe(415);
    expect(drops.drop).not.toHaveBeenCalled();
  });

  it('hands code dropped on a story to the story, and says what became of it', async () => {
    const { drops, storyDrops, routes } = await setUp();
    const outcome = { ok: true as const, drop: { id: 'd1', branch: 'drop/l1/d1', paths: ['logo.svg'], at: 'now', by: TEST_USER.id, state: 'merged' as const }, said: 'logo.svg merged into the story\'s checkout' };
    storyDrops.drop.mockResolvedValueOnce(outcome);
    const res = await routes.post('/proj-1/files/drop', undefined, { raw: dropBody({ leafId: 'l1' }, [{ path: 'logo.svg', bytes: Buffer.from('<svg/>') }]), headers });
    expect([res.status, res.data]).toEqual([201, outcome]);
    expect(storyDrops.drop).toHaveBeenCalledWith(TEST_USER.id, 'proj-1', 'l1', matches<readonly DroppedFile[]>((files) => files.length === 1 && files[0]?.size === 6), undefined);
    expect(drops.drop).not.toHaveBeenCalled();
  });

  it('says why a story took none of a drop', async () => {
    const { storyDrops, routes } = await setUp();
    storyDrops.drop.mockResolvedValueOnce({ ok: false, status: 404, why: 'There is no such story.' });
    const res = await routes.post('/proj-1/files/drop', undefined, { raw: dropBody({ leafId: 'nope' }, [{ path: 'a', bytes: Buffer.from('a') }]), headers });
    expect([res.status, res.data]).toEqual([404, { error: 'There is no such story.' }]);
  });
});
