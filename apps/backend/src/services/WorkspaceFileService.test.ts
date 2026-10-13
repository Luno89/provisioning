import { describe, expect, it } from 'vitest';
import { WorkspaceFileService, type WorkspaceFileDeps } from './WorkspaceFileService.js';

function world(text: string | undefined, over: Partial<WorkspaceFileDeps> = {}) {
  const writes: { path: string; content: string; message: string }[] = [];
  const service = new WorkspaceFileService({
    trees: async () => [{ id: 't1', ownerId: 'u1' }, { id: 'bare', ownerId: 'u1' }],
    repoOf: async (treeId) => (treeId === 't1' ? { repo: 'shop' } : undefined),
    read: async (ownerId, repo, path, ref) => (ownerId === 'u1' && repo === 'shop' && path === '.koala/workspace.json' && ref === 'main' ? text : undefined),
    write: async (ownerId, repo, path, content, message, branch) => { writes.push({ path, content, message }); expect([ownerId, repo, branch]).toEqual(['u1', 'shop', 'main']); return { changed: true, commit: 'c0ffee' }; },
    branch: 'main',
    ...over,
  });
  return { service, writes };
}

describe('a tree\'s workspace file', () => {
  it('is read from its tree\'s repository on main, and is empty when there is none', async () => {
    expect(await world('{"packages":{"dnf":["jq"]}}').service.read('u1', 't1')).toMatchObject({ ok: true, file: { packages: { dnf: ['jq'] } } });
    expect(await world(undefined).service.read('u1', 't1')).toMatchObject({ ok: true, file: {} });
  });

  it('is nobody else\'s, and a tree with no repository yet has none', async () => {
    expect(await world('{}').service.read('u2', 't1')).toEqual({ ok: false, why: 'there is no tree "t1"' });
    expect(await world('{}').service.read('u1', 'bare')).toMatchObject({ ok: false, why: expect.stringContaining('has no repository yet') });
  });

  it('commits what an agent asks for to main, saying what was added and why', async () => {
    const { service, writes } = world('{"packages":{"dnf":["jq"]}}');
    expect(await service.change('u1', 't1', { packages: { dnf: ['jq', 'wkhtmltopdf'] } }, 'the invoice report renders to PDF')).toEqual({ ok: true, file: { packages: { dnf: ['jq', 'wkhtmltopdf'] } }, added: ['dnf wkhtmltopdf'], written: true, commit: 'c0ffee' });
    expect(writes).toEqual([{ path: '.koala/workspace.json', content: '{\n  "packages": {\n    "dnf": [\n      "jq",\n      "wkhtmltopdf"\n    ]\n  }\n}\n', message: 'Workspace: add dnf wkhtmltopdf\n\nthe invoice report renders to PDF' }]);
  });

  it('commits nothing when it has it already, or when the file on main cannot be used', async () => {
    const { service, writes } = world('{"packages":{"dnf":["jq"]}}');
    expect(await service.change('u1', 't1', { packages: { dnf: ['jq'] } }, 'why')).toMatchObject({ ok: true, added: [], written: false });
    expect(await world('not json').service.change('u1', 't1', { packages: { dnf: ['jq'] } }, 'why')).toMatchObject({ ok: false, why: expect.stringContaining('is not JSON') });
    expect(writes).toEqual([]);
  });

  it('says so, committing nothing, when main moved under it', async () => {
    const { service } = world('{}', { write: async () => { throw new Error('".koala/workspace.json" changed on main while it was being written; read it again and retry.'); } });
    expect(await service.change('u1', 't1', { packages: { dnf: ['jq'] } }, 'why')).toEqual({ ok: false, why: expect.stringContaining('changed on main') });
  });

  it('saves a whole file the person edited, refusing one it cannot use', async () => {
    const { service, writes } = world('{}');
    expect(await service.save('u1', 't1', { packages: { brew: ['jq'] } }, 'edited in the Studio')).toMatchObject({ ok: false, why: expect.stringContaining('"brew" is not a package manager') });
    expect(await service.save('u1', 't1', { languages: ['python'] }, 'edited in the Studio')).toMatchObject({ ok: true, written: true });
    expect(writes.map((write) => write.message)).toEqual(['Workspace: edited in the Studio']);
  });
});
