import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { createFilesTools, type FilesToolDeps } from './handlers.js';
import { LIST_FILES, READ_STORED_FILE, REMOVE_STORED_FILE, STORE_FILE } from './catalogue.js';
import type { FileScope } from '../../files/services/FileService.js';
import type { ProjectMetadata } from '../../platform/lib/types.js';

const shop = { id: 'p1', name: 'Shop', ownerId: 'u1', appType: 'gitapp', createdAt: 'now' } as ProjectMetadata;

function tools(over: Partial<FilesToolDeps['files']> = {}) {
  const seen: { op: string; scope: FileScope; path: string }[] = [];
  const files = {
    list: vi.fn(async (_owner: string, scope: FileScope, dir: string) => { seen.push({ op: 'list', scope, path: dir }); return { ok: true as const, value: [{ name: 'photos', path: 'photos', type: 'dir' as const }, { name: 'brief.md', path: 'brief.md', type: 'file' as const, size: 2048 }] }; }),
    download: vi.fn(async (_owner: string, scope: FileScope, path: string) => {
      seen.push({ op: 'download', scope, path });
      return path.endsWith('.png')
        ? { ok: true as const, value: { stream: Readable.from([Buffer.from([0x89, 0x50])]), size: 2, contentType: 'image/png' } }
        : { ok: true as const, value: { stream: Readable.from([Buffer.from('# Brief\nMake it blue.')]), size: 21, contentType: 'application/octet-stream' } };
    }),
    upload: vi.fn(async (_owner: string, scope: FileScope, path: string) => { seen.push({ op: 'upload', scope, path }); return { ok: true as const, value: { path } }; }),
    remove: vi.fn(async (_owner: string, scope: FileScope, path: string) => { seen.push({ op: 'remove', scope, path }); return { ok: true as const, value: { path } }; }),
    ...over,
  };
  const made = createFilesTools({
    files,
    projects: async () => [shop],
    projectOfTree: async (_owner, treeId) => (treeId === 't1' ? 'p1' : undefined),
    projectOfConversation: async () => undefined,
  });
  const call = (name: string, parsed: Record<string, unknown>, caller: Record<string, string> = { ownerId: 'u1' }) =>
    made[name]!({ name, parsed, driver: undefined, caller });
  return { call, seen, files };
}

describe('the files tools', () => {
  it('list the project named, or the one the run works on, or the person\'s own files', async () => {
    const { call, seen } = tools();
    expect((await call(LIST_FILES, { project: 'shop' })).content).toBe('Shop, top:\nphotos/\nbrief.md (2.0 KB)');
    await call(LIST_FILES, { folder: 'photos' }, { ownerId: 'u1', treeId: 't1' });
    await call(LIST_FILES, {});
    expect(seen.map((entry) => [entry.scope.kind, entry.path])).toEqual([['project', ''], ['project', 'photos'], ['mine', '']]);
    expect((await call(LIST_FILES, { project: 'blog' })).content).toBe('no project of yours is called blog; there are Shop');
  });

  it('read text whole, judged by its name when the server does not say, and describe a binary file instead', async () => {
    const { call } = tools();
    expect((await call(READ_STORED_FILE, { project: 'p1', path: 'brief.md' })).content).toBe('# Brief\nMake it blue.');
    expect((await call(READ_STORED_FILE, { project: 'p1', path: 'logo.png' })).content).toBe('logo.png is image/png, 2 bytes; it is not text, so it is described rather than read.');
  });

  it('store and remove inside the project\'s files only', async () => {
    const { call, seen } = tools();
    expect((await call(STORE_FILE, { project: 'p1', path: 'notes/summary.md', content: 'done' })).content).toBe('Stored notes/summary.md in Shop (4 bytes).');
    expect((await call(REMOVE_STORED_FILE, { project: 'p1', path: 'notes' })).content).toBe('Removed notes from Shop.');
    expect(seen.map((entry) => `${entry.op} ${entry.path}`)).toEqual(['upload notes/summary.md', 'remove notes']);
    expect((await call(STORE_FILE, { project: 'p1', path: '../../etc/x', content: 'x' })).ok).toBe(false);
  });

  it('say plainly why when the project has no file server', async () => {
    const { call } = tools({ list: vi.fn(async () => ({ ok: false as const, status: 409 as const, why: 'This project has no file server yet.' })) });
    expect(await call(LIST_FILES, { project: 'p1' })).toEqual({ ok: false, digest: 'This project has no file server yet.', content: 'This project has no file server yet.' });
  });

  it('answer that files cannot be reached where nothing serves them, rather than offering a tool with nothing behind it', async () => {
    const made = createFilesTools(undefined);
    expect(await made[LIST_FILES]!({ name: LIST_FILES, parsed: {}, driver: undefined, caller: { ownerId: 'u1' } })).toMatchObject({ ok: false, content: 'the person\'s file servers cannot be reached from here' });
  });
});
