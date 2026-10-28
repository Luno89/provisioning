import { describe, it, expect, afterEach, vi } from 'vitest';
import axios from 'axios';
import crypto from 'crypto';
import type { Socket } from 'socket.io';
import { projectFilesRouter } from './project-files.js';
import { mountRouter, type Harness, TEST_USER } from '../../platform/routes/test-harness.js';
import { allowed, type Principal } from '../../platform/lib/permissions.js';
import { GiteaConflictError } from '../../projects/services/GiteaService.js';
import { RepositoryDropService } from '../services/RepositoryDropService.js';
import { DROP_TYPE, dropBody } from '../lib/drops.js';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import { registerDevice } from '../../machines/lib/local-agent-registry.js';
import type { Database } from '../../platform/lib/db-interface.js';

const project = {
  id: 'proj-1',
  name: 'demo',
  giteaOwner: 'acme',
  giteaRepo: 'demo',
  ownerId: TEST_USER.id,
  appType: 'gitapp',
  createdAt: '2026-01-01T00:00:00Z',
};

const deviceProject = {
  id: 'proj-device',
  name: 'machine project',
  ownerId: TEST_USER.id,
  appType: 'local',
  executionTarget: { kind: 'local-device' as const, deviceId: 'dev-1' },
  createdAt: '2026-01-01T00:00:00Z',
};

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; vi.restoreAllMocks(); });

async function mount(gitea: Record<string, unknown>, opts: { seedProject?: boolean } = { seedProject: true }): Promise<Harness> {
  const projectRepoService = { editorCredential: vi.fn(async () => ({ token: 'tok-1', username: 'acme' })) };
  const harness = await mountRouter({
    prefix: '/api/projects',
    router: async (db: Database) => {
      if (opts.seedProject !== false) await db.projects.saveProjectInfo(project as never);
      return projectFilesRouter({
        projectRepoService,
        giteaService: gitea,
        drops: new RepositoryDropService({
          credential: projectRepoService.editorCredential,
          commit: (...args) => (gitea.commitDropFromDisk as (...given: unknown[]) => Promise<{ commit: string }>)(...args),
          writeOnDevice: vi.fn(),
        }),
        storyDrops: { drop: (gitea.storyDrop as (...given: unknown[]) => Promise<unknown>) ?? vi.fn() },
        getOwnedProject: async (id: string, principal: Principal) => {
          const p = (await db.projects.getProjects()).find((x: any) => x.id === id);
          return p && allowed(principal, 'see', { kind: 'project', ownerId: p.ownerId }) ? p : undefined;
        },
      });
    },
  });
  h = harness;
  return harness;
}

function fakeSocket(handler: (event: string, payload: unknown, ack: (...args: any[]) => void) => void): Socket {
  return {
    connected: true,
    once: () => undefined,
    off: () => undefined,
    emit: (event: string, payload: unknown, ack: (...args: any[]) => void) => handler(event, payload, ack),
  } as unknown as Socket;
}

async function mountForDevice(): Promise<Harness> {
  const projectRepoService = { editorCredential: vi.fn() };
  const harness = await mountRouter({
    prefix: '/api/projects',
    router: async (db: Database) => {
      await db.projects.saveProjectInfo(deviceProject as never);
      return projectFilesRouter({
        projectRepoService,
        giteaService: {},
        getOwnedProject: async (id: string, principal: Principal) => {
          const p = (await db.projects.getProjects()).find((x: any) => x.id === id);
          return p && allowed(principal, 'see', { kind: 'project', ownerId: p.ownerId }) ? p : undefined;
        },
      });
    },
  });
  h = harness;
  return harness;
}

describe('GET /:id/files', () => {
  it('lists a directory using a per-user editor token', async () => {
    const listDirectory = vi.fn(async () => [{ path: 'src', name: 'src', type: 'dir' as const }]);
    const harness = await mount({ listDirectory });
    const res = await axios.get(harness.url('/api/projects/proj-1/files'));
    expect(res.data.entries).toEqual([{ path: 'src', name: 'src', type: 'dir' }]);
    expect(listDirectory).toHaveBeenCalledWith('tok-1', 'acme', 'demo', '', undefined);
  });

  it('refuses a path that escapes the repo', async () => {
    const harness = await mount({ listDirectory: vi.fn() });
    const err = await axios.get(harness.url('/api/projects/proj-1/files?path=../etc')).catch((e) => e);
    expect(err.response.status).toBe(400);
  });

  it('404s a project owned by someone else', async () => {
    const harness = await mount({ listDirectory: vi.fn() });
    const err = await axios.get(harness.url('/api/projects/ghost/files')).catch((e) => e);
    expect(err.response.status).toBe(404);
  });
});

describe('GET /:id/files/content', () => {
  it('returns the file content and sha', async () => {
    const getFileContent = vi.fn(async () => ({ path: 'README.md', content: '# hi', sha: 'abc123' }));
    const harness = await mount({ getFileContent });
    const res = await axios.get(harness.url('/api/projects/proj-1/files/content?path=README.md'));
    expect(res.data).toEqual({ path: 'README.md', content: '# hi', sha: 'abc123' });
  });

  it('404s a missing file', async () => {
    const harness = await mount({ getFileContent: vi.fn(async () => null) });
    const err = await axios.get(harness.url('/api/projects/proj-1/files/content?path=ghost.md')).catch((e) => e);
    expect(err.response.status).toBe(404);
  });

  it('refuses an empty path', async () => {
    const harness = await mount({ getFileContent: vi.fn() });
    const err = await axios.get(harness.url('/api/projects/proj-1/files/content')).catch((e) => e);
    expect(err.response.status).toBe(400);
  });
});

describe('PUT /:id/files/content', () => {
  it('saves with the given sha and a default message', async () => {
    const updateFile = vi.fn(async () => ({ sha: 'def456' }));
    const harness = await mount({ updateFile });
    const res = await axios.put(harness.url('/api/projects/proj-1/files/content'), {
      path: 'src/index.ts', content: 'export {}', sha: 'abc123',
    });
    expect(res.data).toEqual({ sha: 'def456' });
    expect(updateFile).toHaveBeenCalledWith('tok-1', 'acme', 'demo', 'src/index.ts', 'export {}', 'Update src/index.ts', 'abc123', undefined);
  });

  it('requires a sha', async () => {
    const harness = await mount({ updateFile: vi.fn() });
    const err = await axios.put(harness.url('/api/projects/proj-1/files/content'), { path: 'a.ts', content: 'x' }).catch((e) => e);
    expect(err.response.status).toBe(400);
  });

  it('surfaces a stale sha as a 409, not a 500', async () => {
    const updateFile = vi.fn(async () => { throw new GiteaConflictError('changed since it was loaded'); });
    const harness = await mount({ updateFile });
    const err = await axios.put(harness.url('/api/projects/proj-1/files/content'), {
      path: 'a.ts', content: 'x', sha: 'stale',
    }).catch((e) => e);
    expect(err.response.status).toBe(409);
  });
});

describe('DELETE /:id/files/content', () => {
  it('deletes with the given sha', async () => {
    const deleteFile = vi.fn(async () => undefined);
    const harness = await mount({ deleteFile });
    const res = await axios.delete(harness.url('/api/projects/proj-1/files/content?path=old.ts&sha=abc123'));
    expect(res.data).toEqual({ success: true });
    expect(deleteFile).toHaveBeenCalledWith('tok-1', 'acme', 'demo', 'old.ts', 'Delete old.ts', 'abc123', undefined);
  });

  it('surfaces a stale sha as a 409', async () => {
    const deleteFile = vi.fn(async () => { throw new GiteaConflictError('changed since it was loaded'); });
    const harness = await mount({ deleteFile });
    const err = await axios.delete(harness.url('/api/projects/proj-1/files/content?path=old.ts&sha=stale')).catch((e) => e);
    expect(err.response.status).toBe(409);
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

    const res = await axios.get(harness.url('/api/projects/proj-device/files/content?path=README.md'));
    expect(res.data.path).toBe('README.md');
    expect(res.data.content).toBe('# hi');
    expect(res.data.sha).toMatch(/^[0-9a-f]{64}$/);
  });

  it('404s a file that does not exist on the device', async () => {
    registerDevice('dev-1', TEST_USER.id, '/x', fakeSocket((_event, _payload, ack) => {
      ack({ error: 'ENOENT: no such file or directory' });
    }));
    const harness = await mountForDevice();

    const err = await axios.get(harness.url('/api/projects/proj-device/files/content?path=ghost.md')).catch((e) => e);
    expect(err.response.status).toBe(404);
  });

  it('writes a file over the local-agent connection when the sha matches', async () => {
    let wrote: unknown;
    registerDevice('dev-1', TEST_USER.id, '/x', fakeSocket((event, payload: any, ack) => {
      if (event === 'sandbox:readFile') return ack({ content: 'old' });
      wrote = { event, payload };
      ack();
    }));
    const harness = await mountForDevice();

    const sha = crypto.createHash('sha256').update('old').digest('hex');
    const res = await axios.put(harness.url('/api/projects/proj-device/files/content'), {
      path: 'a.ts', content: 'new', sha,
    });
    expect(res.data.sha).toMatch(/^[0-9a-f]{64}$/);
    expect(wrote).toEqual({ event: 'sandbox:writeFile', payload: { leafId: expect.any(String), path: 'a.ts', content: 'new' } });
  });

  it('refuses to write with a stale sha, 409', async () => {
    registerDevice('dev-1', TEST_USER.id, '/x', fakeSocket((_event, _payload, ack) => {
      ack({ content: 'changed on disk' });
    }));
    const harness = await mountForDevice();

    const err = await axios.put(harness.url('/api/projects/proj-device/files/content'), {
      path: 'a.ts', content: 'new', sha: 'stale-sha',
    }).catch((e) => e);
    expect(err.response.status).toBe(409);
  });

  it('deletes a file when the sha matches', async () => {
    let deleted: unknown;
    registerDevice('dev-1', TEST_USER.id, '/x', fakeSocket((event, payload: any, ack) => {
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

    const err = await axios.delete(harness.url('/api/projects/proj-device/files/content?path=old.ts&sha=abc123')).catch((e) => e);
    expect(err.response.status).toBe(409);
  });
});

describe('POST /:id/files/drop', () => {
  const sent = { headers: { 'Content-Type': DROP_TYPE }, validateStatus: () => true };
  const received = (into: { path: string; bytes: Buffer; source: string }[]) => vi.fn(async (_auth: unknown, _owner: string, _repo: string, files: { path: string; source: string }[]) => {
    for (const file of files) into.push({ path: file.path, source: file.source, bytes: await readFile(file.source) });
    return { commit: 'c1' };
  });

  it('commits what was dropped, under the folder it was dropped on, streamed in pieces with its bytes intact', async () => {
    const got: { path: string; bytes: Buffer; source: string }[] = [];
    const commitDropFromDisk = received(got);
    const harness = await mount({ commitDropFromDisk });
    const png = Buffer.from(Array.from({ length: 200_000 }, (_, index) => (index * 13) % 256));
    const body = dropBody({ dir: 'public', ref: 'story-1' }, [{ path: 'logo.png', bytes: png }]);
    const pieces = Readable.from(Array.from({ length: Math.ceil(body.length / 1000) }, (_, index) => body.subarray(index * 1000, (index + 1) * 1000)));
    const res = await axios.post(harness.url('/api/projects/proj-1/files/drop'), pieces, sent);
    expect(res.status).toBe(201);
    expect(res.data).toEqual({ ok: true, paths: ['public/logo.png'], commit: 'c1' });
    expect(commitDropFromDisk).toHaveBeenCalledWith({ token: 'tok-1', username: 'acme' }, 'acme', 'demo', [expect.objectContaining({ path: 'public/logo.png', size: png.length })], 'Add public/logo.png', 'story-1');
    expect(got.map((file) => [file.path, file.bytes])).toEqual([['public/logo.png', png]]);
    await vi.waitFor(() => expect(existsSync(got[0]!.source)).toBe(false));
  });

  it('refuses a file that would land outside the repository, a drop into someone else\'s project, and a drop sent as anything else', async () => {
    const harness = await mount({ commitDropFromDisk: vi.fn() });
    const outside = await axios.post(harness.url('/api/projects/proj-1/files/drop'), dropBody({}, [{ path: '../x', bytes: Buffer.from('x') }]), sent);
    expect(outside.status).toBe(400);
    expect(outside.data).toEqual({ error: '../x would land outside the repository' });
    const missing = await axios.post(harness.url('/api/projects/nope/files/drop'), dropBody({}, [{ path: 'x', bytes: Buffer.from('x') }]), sent);
    expect(missing.status).toBe(404);
    const json = await axios.post(harness.url('/api/projects/proj-1/files/drop'), { files: [] }, { validateStatus: () => true });
    expect(json.status).toBe(415);
  });

  it('hands code dropped on a story to the story, and says what became of it', async () => {
    const storyDrop = vi.fn(async () => ({ ok: true, drop: { id: 'd1', state: 'merged' }, said: 'logo.svg merged into the story\'s checkout' }));
    const commitDropFromDisk = vi.fn();
    const harness = await mount({ commitDropFromDisk, storyDrop });
    const res = await axios.post(harness.url('/api/projects/proj-1/files/drop'), dropBody({ leafId: 'l1' }, [{ path: 'logo.svg', bytes: Buffer.from('<svg/>') }]), sent);
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({ said: 'logo.svg merged into the story\'s checkout' });
    expect(storyDrop).toHaveBeenCalledWith(TEST_USER.id, 'proj-1', 'l1', [expect.objectContaining({ path: 'logo.svg', size: 6 })], undefined);
    expect(commitDropFromDisk).not.toHaveBeenCalled();
  });
});
