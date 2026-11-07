import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { createFilesTools, type FilesToolDeps } from './handlers.js';
import { LIST_FILES, READ_STORED_FILE, REMOVE_STORED_FILE, STORE_FILE } from './catalogue.js';
import type { FileScope } from '../../files/lib/file-places.js';
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
    downloadIn: vi.fn(async (_owner: string, scope: FileScope, fileId: string) => {
      seen.push({ op: 'downloadIn', scope, path: fileId });
      return fileId === 'f1'
        ? { ok: true as const, value: { stream: Readable.from([Buffer.from('attached notes')]), size: 14, contentType: 'text/plain', path: 'chats/c1/notes.txt' } }
        : { ok: false as const, status: 404 as const, why: `There is no file ${fileId} here.` };
    }),
    upload: vi.fn(async (_owner: string, scope: FileScope, path: string) => { seen.push({ op: 'upload', scope, path }); return { ok: true as const, value: { path, id: 'f9' } }; }),
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
  it('list the project named, or the one the run works on, or the chat\'s own files, or the person\'s own files', async () => {
    const { call, seen } = tools();
    expect((await call(LIST_FILES, { project: 'shop' })).content).toBe('Shop, top:\nphotos/\nbrief.md (2.0 KB)');
    await call(LIST_FILES, { folder: 'photos' }, { ownerId: 'u1', treeId: 't1' });
    expect((await call(LIST_FILES, {}, { ownerId: 'u1', conversationId: 'c1' })).content).toBe('this chat\'s files, top:\nphotos/\nbrief.md (2.0 KB)');
    await call(LIST_FILES, {});
    expect(seen.map((entry) => [entry.scope.kind, entry.path])).toEqual([['project', ''], ['project', 'photos'], ['conversation', ''], ['person', '']]);
    expect(seen[2]?.scope).toEqual({ kind: 'conversation', conversationId: 'c1' });
    expect((await call(LIST_FILES, { project: 'blog' })).content).toBe('no project of yours is called blog; there are Shop');
  });

  it('read text whole, judged by its name when the server does not say, and describe a binary file instead', async () => {
    const { call } = tools();
    expect((await call(READ_STORED_FILE, { project: 'p1', path: 'brief.md' })).content).toBe('# Brief\nMake it blue.');
    expect((await call(READ_STORED_FILE, { project: 'p1', path: 'logo.png' })).content).toBe('logo.png is image/png, 2 bytes; it is not text, so it is described rather than read.');
  });

  it('read an attached file by its id, in the scope the run is in, and say when it is not there', async () => {
    const { call, seen } = tools();
    expect(await call(READ_STORED_FILE, { fileId: 'f1' }, { ownerId: 'u1', conversationId: 'c1' })).toEqual({ ok: true, digest: 'read chats/c1/notes.txt', content: 'attached notes' });
    expect(seen.at(-1)).toEqual({ op: 'downloadIn', scope: { kind: 'conversation', conversationId: 'c1' }, path: 'f1' });
    expect(await call(READ_STORED_FILE, { fileId: 'f2', path: 'ignored.txt' }, { ownerId: 'u1', conversationId: 'c1' })).toEqual({ ok: false, digest: 'There is no file f2 here.', content: 'There is no file f2 here.' });
    expect((await call(READ_STORED_FILE, {})).ok).toBe(false);
  });

  it('store and remove inside the project\'s files only', async () => {
    const { call, seen } = tools();
    expect((await call(STORE_FILE, { project: 'p1', path: 'notes/summary.md', content: 'done' })).content).toBe('Stored notes/summary.md in Shop (4 bytes).');
    expect((await call(REMOVE_STORED_FILE, { project: 'p1', path: 'notes' })).content).toBe('Removed notes from Shop.');
    expect(seen.map((entry) => `${entry.op} ${entry.path}`)).toEqual(['upload notes/summary.md', 'remove notes']);
    expect((await call(STORE_FILE, { project: 'p1', path: '../../etc/x', content: 'x' })).ok).toBe(false);
  });

  it('say plainly why a folder cannot be listed', async () => {
    const { call } = tools({ list: vi.fn(async () => ({ ok: false as const, status: 404 as const, why: 'docs is not a folder here' })) });
    expect(await call(LIST_FILES, { project: 'p1', folder: 'docs' })).toEqual({ ok: false, digest: 'docs is not a folder here', content: 'docs is not a folder here' });
  });

  it('answer that files cannot be reached where nothing serves them, rather than offering a tool with nothing behind it', async () => {
    const made = createFilesTools(undefined);
    expect(await made[LIST_FILES]!({ name: LIST_FILES, parsed: {}, driver: undefined, caller: { ownerId: 'u1' } })).toMatchObject({ ok: false, content: 'the person\'s files cannot be reached from here' });
  });
});
