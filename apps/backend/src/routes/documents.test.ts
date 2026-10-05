import { describe, it, expect, afterAll } from 'vitest';
import { documentsRouter } from './documents.js';
import { mountRouter, TEST_USER, type Harness } from './test-harness.js';
import { DocumentService } from '../services/DocumentService.js';

const reads: string[] = [];
const harness: Harness = await mountRouter({
  prefix: '/api/documents',
  router: () => documentsRouter({
    documents: new DocumentService({
      owns: async (userId, kind, id) => userId === TEST_USER.id && ((kind === 'conversation' && id === 'c1') || (kind === 'tree' && id === 't1')),
      read: async (_userId, repo, path, ref) => {
        reads.push(`${repo}:${path}@${ref}`);
        if (path === 'research/r1/findings.md' && ref === 'main') return { owner: 'koala-u1', repo, content: '# Findings' };
        if (path === 'src/health.ts' && ref === 'c0ffee1') return { owner: 'koala-u1', repo, content: 'on the branch' };
        if (path === 'src/health.ts' && ref === 'main') return { owner: 'koala-u1', repo, content: 'merged' };
        if (path === 'notes.md' && ref === 'c0ffee1') return { owner: 'koala-u1', repo, content: 'only on the branch' };
        return null;
      },
    }),
  }),
});

afterAll(async () => { await harness.close(); });

const open = (workspace: string, path: string, at?: string) => fetch(harness.url(`/api/documents/${workspace}?path=${encodeURIComponent(path)}${at ? `&at=${encodeURIComponent(at)}` : ''}`));

describe('opening a document', () => {
  it('reads a file of the person\'s own conversation from its repository', async () => {
    const res = await open('conversation-c1', 'research/r1/findings.md');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workspace: 'conversation-c1', path: 'research/r1/findings.md', owner: 'koala-u1', repo: 'research-c1', ref: 'main', content: '# Findings' });
  });

  it('reads a leaf\'s file at the commit it claimed, and from main once that commit is gone', async () => {
    reads.length = 0;
    expect(await (await open('tree-t1', 'notes.md', 'c0ffee1')).json()).toMatchObject({ ref: 'c0ffee1', content: 'only on the branch' });
    expect(await (await open('tree-t1', 'src/health.ts', 'c0ffee1')).json()).toMatchObject({ ref: 'c0ffee1', content: 'on the branch' });
    expect(await (await open('tree-t1', 'research/r1/findings.md', 'c0ffee1')).json()).toMatchObject({ ref: 'main', repo: 'tree-t1' });
    expect(reads).toEqual(['tree-t1:notes.md@c0ffee1', 'tree-t1:src/health.ts@c0ffee1', 'tree-t1:research/r1/findings.md@c0ffee1', 'tree-t1:research/r1/findings.md@main']);
  });

  it('takes only a commit as where to read from', async () => {
    reads.length = 0;
    expect((await open('tree-t1', 'notes.md', 'main;rm')).status).toBe(400);
    expect((await open('tree-t1', 'notes.md', '../x')).status).toBe(400);
    expect(reads).toEqual([]);
  });

  it('says a file is not saved yet rather than inventing one', async () => {
    const res = await open('conversation-c1', 'research/r9/findings.md');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('research/r9/findings.md has not been saved to research-c1');
  });

  it('never reads someone else\'s workspace, or outside the repository', async () => {
    reads.length = 0;
    expect((await open('conversation-c2', 'research/r1/findings.md')).status).toBe(404);
    expect((await open('run-7', 'a.md')).status).toBe(404);
    expect((await open('conversation-c1', '../research-c2/findings.md')).status).toBe(400);
    expect((await open('conversation-c1', '.git/config')).status).toBe(400);
    expect(reads).toEqual([]);
  });
});
