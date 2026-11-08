import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { documentsRouter } from './documents.js';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { DocumentService } from '../services/DocumentService.js';
import { createWorkspaceRepoResolver } from '../../engine-host/sandboxes/workspace-repos.js';
import { ownedBy } from '../../platform/lib/ownership.js';
import { GiteaService } from '../../projects/services/GiteaService.js';
import { ProjectRepoService } from '../../projects/services/ProjectRepoService.js';
import { startRealGitea, type RealGitea } from '../../projects/testing/real-gitea.js';

const KEY = 'documents-route-test-key' as never;
const reads: string[] = [];
let gitea: RealGitea;
let dataDir: string;
let harness: Harness;
let owner: string;
let claimed: string;

const asAdmin = (): Record<string, string> => ({ Authorization: `Basic ${Buffer.from(`provisioning-bot:${gitea.adminPassword}`).toString('base64')}`, 'content-type': 'application/json' });

const giteaApi = async (method: string, route: string, body?: unknown): Promise<unknown> => {
  const answer = await fetch(`${gitea.url}/api/v1${route}`, { method, headers: asAdmin(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!answer.ok) throw new Error(`Gitea answered ${method} ${route} with ${answer.status}: ${await answer.text()}`);
  return answer.status === 204 ? undefined : answer.json();
};

const headOf = async (repo: string): Promise<string> => ((await giteaApi('GET', `/repos/${owner}/${repo}/branches/main`)) as { commit: { id: string } }).commit.id;

beforeAll(async () => {
  gitea = await startRealGitea();
  dataDir = await mkdtemp(path.join(tmpdir(), 'documents-route-gitea-'));
  await writeFile(path.join(dataDir, '.gitea-admin-password'), gitea.adminPassword);
  const giteaService = new GiteaService(KEY, { url: gitea.url }, { dataDir });

  harness = await mountRouter({
    prefix: '/api/documents',
    router: (db) => {
      const projectRepos = new ProjectRepoService(db, giteaService, KEY);
      return documentsRouter({
        documents: new DocumentService({
          repoFor: createWorkspaceRepoResolver({ trees: () => db.projects.getTrees(), projects: () => db.projects.getProjects(), accountOf: async (ownerId) => (await db.projects.getGiteaAccount(ownerId))?.username }),
          owns: async (userId, kind, id) => (kind === 'tree'
            ? ownedBy(await db.projects.getTrees(), userId).some((tree) => tree.id === id)
            : (await db.engine.getConversations()).some((conversation) => conversation.ownerId === userId && conversation.id === id)),
          read: (userId, repo, file, ref) => {
            reads.push(`${repo}:${file}@${ref}`);
            return projectRepos.readDocument(userId, repo, file, ref);
          },
        }),
      });
    },
  });

  const { db } = harness;
  await db.engine.saveConversation({ id: 'c1', ownerId: TEST_USER.id, title: 'research', messages: [], createdAt: 'then', updatedAt: 'then' } as never);
  await db.engine.saveConversation({ id: 'c2', ownerId: 'someone-else', title: 'theirs', messages: [], createdAt: 'then', updatedAt: 'then' } as never);
  await db.projects.saveTree({ id: 't1', ownerId: TEST_USER.id, name: 'Health', type: 'api', createdAt: 'then', updatedAt: 'then' } as never);
  owner = (await new ProjectRepoService(db, giteaService, KEY).ensureAccountFor(TEST_USER.id)).username;

  await giteaService.createRepoForUser(owner, 'research-c1');
  await giteaService.commitFiles(owner, 'research-c1', [{ path: 'research/r1/findings.md', content: '# Findings' }], 'Research findings');
  await giteaService.createRepoForUser(owner, 'research-c2');
  await giteaService.commitFiles(owner, 'research-c2', [{ path: 'findings.md', content: 'not theirs to read' }], 'Elsewhere');

  await giteaService.createRepoForUser(owner, 'tree-t1');
  await giteaService.commitFiles(owner, 'tree-t1', [{ path: 'notes.md', content: 'only on the branch' }, { path: 'src/health.ts', content: 'on the branch' }], 'The leaf\'s work');
  claimed = await headOf('tree-t1');
  const notes = (await giteaApi('GET', `/repos/${owner}/tree-t1/contents/notes.md`)) as { sha: string };
  await giteaApi('DELETE', `/repos/${owner}/tree-t1/contents/notes.md`, { message: 'Merged without the notes', sha: notes.sha });
  await giteaService.commitFiles(owner, 'tree-t1', [{ path: 'src/health.ts', content: 'merged' }, { path: 'research/r1/findings.md', content: '# Findings on main' }], 'Merged');
}, 0);

afterAll(async () => {
  await harness?.close();
  await gitea?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

const open = (workspace: string, file: string, at?: string) => fetch(harness.url(`/api/documents/${workspace}?path=${encodeURIComponent(file)}${at ? `&at=${encodeURIComponent(at)}` : ''}`));

describe('opening a document', () => {
  it('reads a file of the person\'s own conversation from its repository', async () => {
    const res = await open('conversation-c1', 'research/r1/findings.md');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workspace: 'conversation-c1', path: 'research/r1/findings.md', owner, repo: 'research-c1', ref: 'main', content: '# Findings' });
  });

  it('reads a leaf\'s file at the commit it claimed, and from main once that commit is gone', async () => {
    reads.length = 0;
    expect(await (await open('tree-t1', 'notes.md', claimed)).json()).toMatchObject({ ref: claimed, content: 'only on the branch' });
    expect(await (await open('tree-t1', 'src/health.ts', claimed)).json()).toMatchObject({ ref: claimed, content: 'on the branch' });
    expect(await (await open('tree-t1', 'research/r1/findings.md', claimed)).json()).toMatchObject({ ref: 'main', repo: 'tree-t1' });
    expect(reads).toEqual([`tree-t1:notes.md@${claimed}`, `tree-t1:src/health.ts@${claimed}`, `tree-t1:research/r1/findings.md@${claimed}`, 'tree-t1:research/r1/findings.md@main']);
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
