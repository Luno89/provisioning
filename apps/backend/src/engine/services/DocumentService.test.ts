import { beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { DocumentService } from './DocumentService.js';

type Owns = (ownerId: string, kind: 'tree' | 'conversation', id: string) => Promise<boolean>;
type Read = (ownerId: string, repo: string, path: string, ref: string) => Promise<{ owner: string; repo: string; content: string } | null>;

let owns: ReturnType<typeof mock<{ owns: Owns }>>;
let reads: string[];
let service: DocumentService;

beforeEach(() => {
  reads = [];
  owns = mock<{ owns: Owns }>();
  owns.owns.mockImplementation(async (userId, kind, id) => userId === 'u1' && ((kind === 'conversation' && id === 'c1') || (kind === 'tree' && id === 't1')));
  const read: Read = async (_userId, repo, path, ref) => {
    reads.push(`${repo}:${path}@${ref}`);
    if (path === 'research/r1/findings.md' && ref === 'main') return { owner: 'koala-u1', repo, content: '# Findings' };
    if (path === 'src/health.ts' && ref === 'c0ffee1') return { owner: 'koala-u1', repo, content: 'on the branch' };
    if (path === 'src/health.ts' && ref === 'main') return { owner: 'koala-u1', repo, content: 'merged' };
    if (path === 'notes.md' && ref === 'c0ffee1') return { owner: 'koala-u1', repo, content: 'only on the branch' };
    return null;
  };
  service = new DocumentService({ owns: owns.owns, read });
});

describe('opening a document', () => {
  it('reads a file of the person\'s own conversation from its repository', async () => {
    expect(await service.read('u1', 'conversation-c1', 'research/r1/findings.md')).toEqual({
      ok: true,
      document: { workspace: 'conversation-c1', path: 'research/r1/findings.md', owner: 'koala-u1', repo: 'research-c1', ref: 'main', content: '# Findings' },
    });
  });

  it('reads a leaf\'s file at the commit it claimed, and from main once that commit is gone', async () => {
    expect(await service.read('u1', 'tree-t1', 'notes.md', 'c0ffee1')).toMatchObject({ ok: true, document: { ref: 'c0ffee1', content: 'only on the branch' } });
    expect(await service.read('u1', 'tree-t1', 'src/health.ts', 'c0ffee1')).toMatchObject({ ok: true, document: { ref: 'c0ffee1', content: 'on the branch' } });
    expect(await service.read('u1', 'tree-t1', 'research/r1/findings.md', 'c0ffee1')).toMatchObject({ ok: true, document: { ref: 'main', repo: 'tree-t1' } });
    expect(reads).toEqual(['tree-t1:notes.md@c0ffee1', 'tree-t1:src/health.ts@c0ffee1', 'tree-t1:research/r1/findings.md@c0ffee1', 'tree-t1:research/r1/findings.md@main']);
  });

  it('takes only a commit as where to read from', async () => {
    expect(await service.read('u1', 'tree-t1', 'notes.md', 'main;rm')).toEqual({ ok: false, status: 400, error: 'main;rm is not a commit' });
    expect(await service.read('u1', 'tree-t1', 'notes.md', '../x')).toMatchObject({ ok: false, status: 400 });
    expect(reads).toEqual([]);
  });

  it('says a file is not saved yet rather than inventing one', async () => {
    expect(await service.read('u1', 'conversation-c1', 'research/r9/findings.md')).toEqual({ ok: false, status: 404, error: 'research/r9/findings.md has not been saved to research-c1' });
  });

  it('never reads someone else\'s workspace, or outside the repository', async () => {
    expect(await service.read('u1', 'conversation-c2', 'research/r1/findings.md')).toMatchObject({ ok: false, status: 404 });
    expect(await service.read('u1', 'run-7', 'a.md')).toMatchObject({ ok: false, status: 404, error: 'there is no saved workspace called run-7' });
    expect(await service.read('u1', 'conversation-c1', '../research-c2/findings.md')).toMatchObject({ ok: false, status: 400 });
    expect(await service.read('u1', 'conversation-c1', '.git/config')).toMatchObject({ ok: false, status: 400 });
    expect(await service.read('u2', 'conversation-c1', 'research/r1/findings.md')).toMatchObject({ ok: false, status: 404 });
    expect(reads).toEqual([]);
  });

  it('asks who owns the workspace the name points at, once, before reading', async () => {
    await service.read('u1', 'tree-t1', 'src/health.ts');
    expect(owns.owns).toHaveBeenCalledTimes(1);
    expect(owns.owns).toHaveBeenCalledWith('u1', 'tree', 't1');
  });
});
