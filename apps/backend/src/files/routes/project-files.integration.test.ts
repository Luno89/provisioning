import { anyOf } from '../../platform/lib/test-matchers.js';
import { describe, it, expect, afterEach, afterAll, beforeAll, vi } from 'vitest';
import axios from 'axios';
import crypto from 'crypto';
import type { Socket } from 'socket.io';
import { projectFilesRouter } from './project-files.js';
import { mountRouter, type Harness, TEST_USER } from '../../platform/routes/test-harness.js';
import { allowed, type Principal } from '../../platform/lib/permissions.js';
import { GiteaService } from '../../projects/services/GiteaService.js';
import { startRealGitea, type RealGitea } from '../../projects/testing/real-gitea.js';
import { RepositoryDropService } from '../services/RepositoryDropService.js';
import type { StoryDropService } from '../services/StoryDropService.js';
import { DROP_TYPE, dropBody } from '../lib/drops.js';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { registerDevice } from '../../machines/lib/local-agent-registry.js';
import type { Database } from '../../platform/lib/db-interface.js';

const OWNER = 'acme';

const deviceProject = {
  id: 'proj-device',
  name: 'machine project',
  ownerId: TEST_USER.id,
  appType: 'local',
  executionTarget: { kind: 'local-device' as const, deviceId: 'dev-1' },
  createdAt: '2026-01-01T00:00:00Z',
};

let realGitea: RealGitea;
let gitea: GiteaService;
let scratch: string;
let token: string;
let repos = 0;

beforeAll(async () => {
  realGitea = await startRealGitea();
  scratch = await mkdtemp(path.join(tmpdir(), 'project-files-'));
  const dataDir = path.join(scratch, 'data');
  await mkdir(dataDir);
  await writeFile(path.join(dataDir, '.gitea-admin-password'), realGitea.adminPassword);
  gitea = new GiteaService('project-files-test-key' as never, { url: realGitea.url }, { dataDir });
  const { password } = await gitea.createUserAccount(OWNER, 'acme@koala.local');
  token = (await gitea.createPushToken(OWNER, password)).token;
}, 0);

afterAll(async () => {
  await realGitea.close();
  await rm(scratch, { recursive: true, force: true });
});

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; vi.restoreAllMocks(); });

const credential = () => ({ token, username: OWNER });

const blobSha = (content: string): string => crypto.createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex');

async function onDisk(files: Record<string, string | Buffer>): Promise<{ path: string; source: string }[]> {
  const dir = await mkdtemp(path.join(scratch, 'seed-'));
  return Promise.all(Object.entries(files).map(async ([file, content], index) => {
    const source = path.join(dir, String(index));
    await writeFile(source, content);
    return { path: file, source };
  }));
}

async function seeded(files: Record<string, string>, branches: string[] = []): Promise<string> {
  repos += 1;
  const name = `demo-${repos}`;
  await gitea.createRepoForUser(OWNER, name);
  await gitea.commitDropFromDisk(credential(), OWNER, name, await onDisk(files), 'Seed');
  for (const branch of branches) await gitea.commitDropFromDisk(credential(), OWNER, name, await onDisk({ [`${branch}.txt`]: branch }), `Start ${branch}`, 'main', branch);
  return name;
}

const raw = async (repo: string, file: string, ref: string): Promise<{ status: number; bytes: Buffer }> => {
  const answer = await fetch(`${realGitea.url}/api/v1/repos/${OWNER}/${repo}/raw/${file}?ref=${ref}`, { headers: { Authorization: `token ${token}` } });
  return { status: answer.status, bytes: Buffer.from(await answer.arrayBuffer()) };
};

const headOf = async (repo: string, branch: string): Promise<string> => {
  const answer = await fetch(`${realGitea.url}/api/v1/repos/${OWNER}/${repo}/branches/${branch}`, { headers: { Authorization: `token ${token}` } });
  return ((await answer.json()) as { commit: { id: string } }).commit.id;
};

const notCalled = (what: string) => (): never => { throw new Error(`${what} was not expected here`); };

const ownedBy = (db: Database) => async (id: string, principal: Principal) => {
  const p = (await db.projects.getProjects()).find((x) => x.id === id);
  return p && allowed(principal, 'see', { kind: 'project', ownerId: p.ownerId }) ? p : undefined;
};

async function mount(repo: string, storyDrop?: StoryDropService['drop']) {
  const editorCredential = vi.fn(async () => credential());
  const spies = {
    listDirectory: vi.spyOn(gitea, 'listDirectory'),
    getFileContent: vi.spyOn(gitea, 'getFileContent'),
    updateFile: vi.spyOn(gitea, 'updateFile'),
    deleteFile: vi.spyOn(gitea, 'deleteFile'),
    commitDropFromDisk: vi.spyOn(gitea, 'commitDropFromDisk'),
  };
  const harness = await mountRouter({
    prefix: '/api/projects',
    router: async (db: Database) => {
      await db.projects.saveProjectInfo({ id: 'proj-1', name: 'demo', giteaOwner: OWNER, giteaRepo: repo, ownerId: TEST_USER.id, appType: 'gitapp', createdAt: '2026-01-01T00:00:00Z' });
      return projectFilesRouter({
        projectRepoService: { editorCredential },
        giteaService: gitea,
        drops: new RepositoryDropService({
          credential: editorCredential,
          commit: (auth, owner, name, files, message, branch) => gitea.commitDropFromDisk(auth, owner, name, files, message, branch),
          writeOnDevice: vi.fn(),
        }),
        storyDrops: { drop: storyDrop ?? notCalled('storyDrop') },
        getOwnedProject: ownedBy(db),
      });
    },
  });
  h = harness;
  return { harness, repo, editorCredential, ...spies };
}

function fakeSocket(handler: (event: string, payload: unknown, ack: (...args: unknown[]) => void) => void): Socket {
  return {
    connected: true,
    once: () => undefined,
    off: () => undefined,
    emit: (event: string, payload: unknown, ack: (...args: unknown[]) => void) => handler(event, payload, ack),
  } as unknown as Socket;
}

async function mountForDevice(): Promise<Harness> {
  const projectRepoService = { editorCredential: notCalled('editorCredential') };
  const harness = await mountRouter({
    prefix: '/api/projects',
    router: async (db: Database) => {
      await db.projects.saveProjectInfo(deviceProject);
      return projectFilesRouter({
        projectRepoService,
        giteaService: { listDirectory: notCalled('listDirectory'), getFileContent: notCalled('getFileContent'), updateFile: notCalled('updateFile'), deleteFile: notCalled('deleteFile') },
        drops: { drop: notCalled('drop') },
        storyDrops: { drop: notCalled('storyDrop') },
        getOwnedProject: ownedBy(db),
      });
    },
  });
  h = harness;
  return harness;
}

const statusOf = async (request: Promise<unknown>): Promise<number | undefined> => {
  try {
    await request;
    return undefined;
  } catch (err) {
    return axios.isAxiosError(err) ? err.response?.status : undefined;
  }
};

describe('GET /:id/files', () => {
  it('lists a directory using a per-user editor token', async () => {
    const { harness, repo, listDirectory } = await mount(await seeded({ 'src/index.ts': 'export {}' }));
    const res = await axios.get<{ entries: unknown }>(harness.url('/api/projects/proj-1/files'));
    expect(res.data.entries).toEqual([
      { path: '.gitignore', name: '.gitignore', type: 'file', size: anyOf(Number) },
      { path: 'README.md', name: 'README.md', type: 'file', size: anyOf(Number) },
      { path: 'src', name: 'src', type: 'dir', size: 0 },
    ]);
    expect(listDirectory).toHaveBeenCalledWith(token, OWNER, repo, '', undefined);
  });

  it('refuses a path that escapes the repo', async () => {
    const { harness, listDirectory } = await mount(await seeded({ 'a.txt': 'a' }));
    expect(await statusOf(axios.get(harness.url('/api/projects/proj-1/files?path=../etc')))).toBe(400);
    expect(listDirectory).not.toHaveBeenCalled();
  });

  it('404s a project owned by someone else', async () => {
    const { harness } = await mount(await seeded({ 'a.txt': 'a' }));
    expect(await statusOf(axios.get(harness.url('/api/projects/ghost/files')))).toBe(404);
  });
});

describe('GET /:id/files/content', () => {
  it('returns the file content and sha', async () => {
    const { harness } = await mount(await seeded({ 'README.md': '# hi' }));
    const res = await axios.get(harness.url('/api/projects/proj-1/files/content?path=README.md'));
    expect(res.data).toEqual({ path: 'README.md', content: '# hi', sha: blobSha('# hi') });
  });

  it('404s a missing file', async () => {
    const { harness } = await mount(await seeded({ 'README.md': '# hi' }));
    expect(await statusOf(axios.get(harness.url('/api/projects/proj-1/files/content?path=ghost.md')))).toBe(404);
  });

  it('refuses an empty path', async () => {
    const { harness, getFileContent } = await mount(await seeded({ 'README.md': '# hi' }));
    expect(await statusOf(axios.get(harness.url('/api/projects/proj-1/files/content')))).toBe(400);
    expect(getFileContent).not.toHaveBeenCalled();
  });
});

describe('PUT /:id/files/content', () => {
  it('saves with the given sha and a default message', async () => {
    const { harness, repo, updateFile } = await mount(await seeded({ 'src/index.ts': 'old' }));
    const res = await axios.put(harness.url('/api/projects/proj-1/files/content'), {
      path: 'src/index.ts', content: 'export {}', sha: blobSha('old'),
    });
    expect(res.data).toEqual({ sha: blobSha('export {}') });
    expect(updateFile).toHaveBeenCalledWith(token, OWNER, repo, 'src/index.ts', 'export {}', 'Update src/index.ts', blobSha('old'), undefined);
    expect((await raw(repo, 'src/index.ts', 'main')).bytes.toString()).toBe('export {}');
  });

  it('requires a sha', async () => {
    const { harness, updateFile } = await mount(await seeded({ 'a.ts': 'a' }));
    expect(await statusOf(axios.put(harness.url('/api/projects/proj-1/files/content'), { path: 'a.ts', content: 'x' }))).toBe(400);
    expect(updateFile).not.toHaveBeenCalled();
  });

  it('surfaces a stale sha as a 409, not a 500', async () => {
    const { harness, repo } = await mount(await seeded({ 'a.ts': 'a' }));
    expect(await statusOf(axios.put(harness.url('/api/projects/proj-1/files/content'), {
      path: 'a.ts', content: 'x', sha: blobSha('what it was before'),
    }))).toBe(409);
    expect((await raw(repo, 'a.ts', 'main')).bytes.toString()).toBe('a');
  });
});

describe('DELETE /:id/files/content', () => {
  it('deletes with the given sha', async () => {
    const { harness, repo, deleteFile } = await mount(await seeded({ 'old.ts': 'bye', 'kept.ts': 'stay' }));
    const res = await axios.delete(harness.url(`/api/projects/proj-1/files/content?path=old.ts&sha=${blobSha('bye')}`));
    expect(res.data).toEqual({ success: true });
    expect(deleteFile).toHaveBeenCalledWith(token, OWNER, repo, 'old.ts', 'Delete old.ts', blobSha('bye'), undefined);
    expect((await raw(repo, 'old.ts', 'main')).status).toBe(404);
  });

  it('surfaces a stale sha as a 409', async () => {
    const { harness, repo } = await mount(await seeded({ 'old.ts': 'bye', 'kept.ts': 'stay' }));
    expect(await statusOf(axios.delete(harness.url(`/api/projects/proj-1/files/content?path=old.ts&sha=${blobSha('what it was before')}`)))).toBe(409);
    expect((await raw(repo, 'old.ts', 'main')).bytes.toString()).toBe('bye');
  });
});

describe('a project scoped to a local machine', () => {
  it('lists a directory over the local-agent connection, not Gitea', async () => {
    registerDevice('dev-1', TEST_USER.id, '/x', fakeSocket((event, payload, ack) => {
      expect(event).toBe('sandbox:listDir');
      expect(payload).toEqual({ path: 'src' });
      ack({ entries: [{ name: 'index.ts', path: 'src/index.ts', type: 'file' }] });
    }));
    const harness = await mountForDevice();

    const res = await axios.get(harness.url('/api/projects/proj-device/files?path=src'));
    expect(res.data).toEqual({ path: 'src', entries: [{ name: 'index.ts', path: 'src/index.ts', type: 'file' }] });
  });

  it('reads file content and derives a sha from it', async () => {
    registerDevice('dev-1', TEST_USER.id, '/x', fakeSocket((_event, _payload, ack) => {
      ack({ content: '# hi' });
    }));
    const harness = await mountForDevice();

    const res = await axios.get<{ path: string; content: string; sha: string }>(harness.url('/api/projects/proj-device/files/content?path=README.md'));
    expect(res.data.path).toBe('README.md');
    expect(res.data.content).toBe('# hi');
    expect(res.data.sha).toMatch(/^[0-9a-f]{64}$/);
  });

  it('404s a file that does not exist on the device', async () => {
    registerDevice('dev-1', TEST_USER.id, '/x', fakeSocket((_event, _payload, ack) => {
      ack({ error: 'ENOENT: no such file or directory' });
    }));
    const harness = await mountForDevice();

    expect(await statusOf(axios.get(harness.url('/api/projects/proj-device/files/content?path=ghost.md')))).toBe(404);
  });

  it('writes a file over the local-agent connection when the sha matches', async () => {
    let wrote: unknown;
    registerDevice('dev-1', TEST_USER.id, '/x', fakeSocket((event, payload, ack) => {
      if (event === 'sandbox:readFile') return ack({ content: 'old' });
      wrote = { event, payload };
      ack();
    }));
    const harness = await mountForDevice();

    const sha = crypto.createHash('sha256').update('old').digest('hex');
    const res = await axios.put<{ sha: string }>(harness.url('/api/projects/proj-device/files/content'), {
      path: 'a.ts', content: 'new', sha,
    });
    expect(res.data.sha).toMatch(/^[0-9a-f]{64}$/);
    expect(wrote).toEqual({ event: 'sandbox:writeFile', payload: { leafId: anyOf(String), path: 'a.ts', content: 'new' } });
  });

  it('refuses to write with a stale sha, 409', async () => {
    registerDevice('dev-1', TEST_USER.id, '/x', fakeSocket((_event, _payload, ack) => {
      ack({ content: 'changed on disk' });
    }));
    const harness = await mountForDevice();

    expect(await statusOf(axios.put(harness.url('/api/projects/proj-device/files/content'), {
      path: 'a.ts', content: 'new', sha: 'stale-sha',
    }))).toBe(409);
  });

  it('deletes a file when the sha matches', async () => {
    let deleted: unknown;
    registerDevice('dev-1', TEST_USER.id, '/x', fakeSocket((event, payload, ack) => {
      if (event === 'sandbox:readFile') return ack({ content: 'bye' });
      deleted = { event, payload };
      ack();
    }));
    const harness = await mountForDevice();

    const sha = crypto.createHash('sha256').update('bye').digest('hex');
    const res = await axios.delete(harness.url(`/api/projects/proj-device/files/content?path=old.ts&sha=${sha}`));
    expect(res.data).toEqual({ success: true });
    expect(deleted).toEqual({ event: 'sandbox:deleteFile', payload: { path: 'old.ts' } });
  });

  it('refuses to delete a file that no longer exists, 409', async () => {
    registerDevice('dev-1', TEST_USER.id, '/x', fakeSocket((_event, _payload, ack) => {
      ack({ error: 'ENOENT: no such file or directory' });
    }));
    const harness = await mountForDevice();

    expect(await statusOf(axios.delete(harness.url('/api/projects/proj-device/files/content?path=old.ts&sha=abc123')))).toBe(409);
  });
});

describe('POST /:id/files/drop', () => {
  const sent = { headers: { 'Content-Type': DROP_TYPE }, validateStatus: () => true };

  it('commits what was dropped, under the folder it was dropped on, streamed in pieces with its bytes intact', async () => {
    const { harness, repo, commitDropFromDisk } = await mount(await seeded({ 'README.md': '# hi' }, ['story-1']));
    const png = Buffer.from(Array.from({ length: 200_000 }, (_, index) => (index * 13) % 256));
    const body = dropBody({ dir: 'public', ref: 'story-1' }, [{ path: 'logo.png', bytes: png }]);
    const pieces = Readable.from(Array.from({ length: Math.ceil(body.length / 1000) }, (_, index) => body.subarray(index * 1000, (index + 1) * 1000)));
    const res = await axios.post(harness.url('/api/projects/proj-1/files/drop'), pieces, sent);
    expect(res.status).toBe(201);
    expect(res.data).toEqual({ ok: true, paths: ['public/logo.png'], commit: await headOf(repo, 'story-1') });
    expect(commitDropFromDisk).toHaveBeenCalledWith({ token, username: OWNER }, OWNER, repo, [expect.objectContaining({ path: 'public/logo.png', size: png.length })], 'Add public/logo.png', 'story-1');
    const stored = await raw(repo, 'public/logo.png', 'story-1');
    expect([stored.status, stored.bytes]).toEqual([200, png]);
    expect((await raw(repo, 'public/logo.png', 'main')).status).toBe(404);
    const source = commitDropFromDisk.mock.calls[0]![3][0]!.source;
    await vi.waitFor(() => expect(existsSync(source)).toBe(false));
  });

  it('refuses a file that would land outside the repository, a drop into someone else\'s project, and a drop sent as anything else', async () => {
    const { harness, commitDropFromDisk } = await mount(await seeded({ 'README.md': '# hi' }));
    const outside = await axios.post(harness.url('/api/projects/proj-1/files/drop'), dropBody({}, [{ path: '../x', bytes: Buffer.from('x') }]), sent);
    expect(outside.status).toBe(400);
    expect(outside.data).toEqual({ error: '../x would land outside the repository' });
    const missing = await axios.post(harness.url('/api/projects/nope/files/drop'), dropBody({}, [{ path: 'x', bytes: Buffer.from('x') }]), sent);
    expect(missing.status).toBe(404);
    const json = await axios.post(harness.url('/api/projects/proj-1/files/drop'), { files: [] }, { validateStatus: () => true });
    expect(json.status).toBe(415);
    expect(commitDropFromDisk).not.toHaveBeenCalled();
  });

  it('hands code dropped on a story to the story, and says what became of it', async () => {
    const storyDrop = vi.fn(async () => ({ ok: true as const, drop: { id: 'd1', branch: 'drop/l1/d1', paths: ['logo.svg'], at: 'now', by: TEST_USER.id, state: 'merged' as const }, said: 'logo.svg merged into the story\'s checkout' }));
    const { harness, repo, commitDropFromDisk } = await mount(await seeded({ 'README.md': '# hi' }), storyDrop);
    const res = await axios.post(harness.url('/api/projects/proj-1/files/drop'), dropBody({ leafId: 'l1' }, [{ path: 'logo.svg', bytes: Buffer.from('<svg/>') }]), sent);
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({ said: 'logo.svg merged into the story\'s checkout' });
    expect(storyDrop).toHaveBeenCalledWith(TEST_USER.id, 'proj-1', 'l1', [expect.objectContaining({ path: 'logo.svg', size: 6 })], undefined);
    expect(commitDropFromDisk).not.toHaveBeenCalled();
    expect((await raw(repo, 'logo.svg', 'main')).status).toBe(404);
  });
});
