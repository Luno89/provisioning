import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { GiteaService } from '../../projects/index.js';
import { startRealGitea, type RealGitea } from '../../projects/testing/real-gitea.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import type { PipelineRunMetadata, ProjectMetadata } from '../../platform/lib/types.js';
import { marked } from '../lib/release-run.js';
import { OdooReleaseService, type ReleaseRuns } from './OdooReleaseService.js';
import { changesIn } from './repo-changes.js';
import { releaseDecider } from './release-decider.js';

const OWNER = 'acme';
let realGitea: RealGitea;
let gitea: GiteaService;
let scratch: string;

beforeAll(async () => {
  realGitea = await startRealGitea();
  scratch = await mkdtemp(path.join(tmpdir(), 'repo-changes-'));
  const dataDir = path.join(scratch, 'data');
  await mkdir(dataDir);
  await writeFile(path.join(dataDir, '.gitea-admin-password'), realGitea.adminPassword);
  gitea = new GiteaService('repo-changes-test-key' as never, { url: realGitea.url }, { dataDir });
  await gitea.createUserAccount(OWNER, 'acme@koala.local');
}, 0);

afterAll(async () => {
  await realGitea.close();
  await rm(scratch, { recursive: true, force: true });
});

const head = async (repo: string): Promise<string> => {
  const answer = await fetch(`${realGitea.url.replace(/\/$/, "")}/api/v1/repos/${OWNER}/${repo}/branches/main`, { headers: { Authorization: `Basic ${Buffer.from(`provisioning-bot:${realGitea.adminPassword}`).toString('base64')}` } });
  return ((await answer.json()) as { commit: { id: string } }).commit.id;
};

describe('what a push changed, read from the project\'s repository', () => {
  it('lets a push of only browser tests run them again on the waiting preview, and anything more make a new release', async () => {
    await gitea.createRepoForUser(OWNER, 'shop');
    await gitea.commitFiles(OWNER, 'shop', [{ path: 'addons/shop/__manifest__.py', content: "{'name': 'Shop'}\n" }, { path: 'e2e/signs-in.spec.ts', content: 'one\n' }], 'Start');
    const first = await head('shop');
    await gitea.commitFiles(OWNER, 'shop', [{ path: 'e2e/sees-the-field.spec.ts', content: 'two\n' }], 'A test that cannot pass');
    const testsOnly = await head('shop');
    await gitea.commitFiles(OWNER, 'shop', [{ path: 'addons/shop/models/order.py', content: 'x = 1\n' }], 'A model');
    const more = await head('shop');

    const changed = changesIn(gitea);
    const project = { id: 'p1', name: 'Shop', ownerId: 'bo', giteaOwner: OWNER, giteaRepo: 'shop', targetClusterId: 'c1' } as ProjectMetadata;
    expect(await changed(project, first, testsOnly)).toEqual(['e2e/sees-the-field.spec.ts']);

    const db = await testDatabase();
    await db.infrastructure.saveCluster({ id: 'c1', name: 'desk', provider: 'machine', status: 'healthy', ownerId: 'bo' });
    const answered: string[] = [];
    const runs = mock<ReleaseRuns>();
    runs.running.mockResolvedValue(true);
    runs.closed.mockResolvedValue(undefined);
    runs.answer.mockImplementation(async (_projectId, choice) => { answered.push(choice); });
    let ids = 0;
    const service = new OdooReleaseService({ store: db, decide: releaseDecider({ trees: db.projects, changed }), runs, changed, chartAt: async () => true, newId: () => `r${(ids += 1)}` });
    const build = (id: string, commit: string) => ({ id, projectId: 'p1', commitSha: commit, imageTag: `reg/acme/shop:${commit.slice(0, 8)}`, status: 'succeeded' }) as PipelineRunMetadata;
    for (const [id, commit] of [['b1', first], ['b2', testsOnly], ['b3', more]] as const) await db.releases.savePipelineRun(build(id, commit));

    await service.release(project, build('b1', first));
    for (const change of marked(await db.releases.getOdooReleases('bo', 'p1'), 'r1', { state: 'preview', slot: 'b', e2e: { state: 'passed', startedAt: 't0', finishedAt: 't1' } }, new Date().toISOString())) await db.releases.saveOdooRelease(change);

    expect(await service.release(project, build('b2', testsOnly))).toEqual({ skipped: `only browser tests changed, and they ran on the waiting preview of ${first.slice(0, 8)}` });
    expect(answered).toEqual(['Run tests again']);
    expect((await db.releases.getOdooReleases('bo', 'p1')).map((release) => [release.id, release.state, release.testsFrom])).toEqual([['r1', 'preview', testsOnly]]);

    expect(await service.release(project, build('b3', more))).toMatchObject({ commit: more });
    await service.stop();
  });
});

describe('whether a build is released, from what its tree type says the app is built from', () => {
  it('releases when a file the app is built from changed, says why not when nothing it is built from did, and does not release when what changed cannot be read', async () => {
    await gitea.createRepoForUser(OWNER, 'books');
    await gitea.commitFiles(OWNER, 'books', [{ path: 'app/main.py', content: 'x = 1\n' }, { path: 'README.md', content: 'one\n' }], 'Start');
    const first = await head('books');
    await gitea.commitFiles(OWNER, 'books', [{ path: 'README.md', content: 'two\n' }], 'Words');
    const words = await head('books');
    await gitea.commitFiles(OWNER, 'books', [{ path: 'app/main.py', content: 'x = 2\n' }], 'Code');
    const code = await head('books');

    const db = await testDatabase();
    await db.projects.saveTreeType({ id: 'books-app', ownerId: 'bo', label: 'Books', summary: 'a books app', language: 'python', produces: 'service', doneMeans: 'it runs', files: [], releaseWhen: ['app/**'] });
    await db.projects.saveTree({ id: 't1', ownerId: 'bo', name: 'Books', type: 'books-app', projectIds: ['p2'], createdAt: 't' } as never);
    const decide = releaseDecider({ trees: db.projects, changed: changesIn(gitea) });
    const project = { id: 'p2', name: 'Books', ownerId: 'bo', giteaOwner: OWNER, giteaRepo: 'books' } as ProjectMetadata;

    expect(await decide(project, first, words)).toEqual({ release: false, reason: `only README.md changed since ${first.slice(0, 8)}, none of which the app is built from` });
    expect(await decide(project, words, code)).toEqual({ release: true });
    const unread = await decide(project, 'f'.repeat(40), code);
    expect(unread.release).toBe(false);
    expect(unread.release ? '' : unread.reason).toMatch(/^what changed since ffffffff could not be read, so the build is not released: /);
    expect(await decide({ ...project, id: 'no-tree' }, first, words)).toEqual({ release: true });
  });
});
