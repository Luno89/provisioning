import { anyOf, matching } from '../../platform/lib/test-matchers.js';
import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { reopening } from '@koala/engine-core/reopening';
import { decryptValue } from '../../platform/lib/crypto.js';
import { GiteaService } from './GiteaService.js';
import { startRealGitea, type RealGitea } from '../testing/real-gitea.js';
import { emptiedEachTime, testDatabase } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import { documentsThroughAnAccountBehaviour, unexpectedRefusals } from '../testing/project-repo-behaviour.js';
import { ProjectRepoService } from './ProjectRepoService.js';

const KEY = 'a'.repeat(64);
const recordingQuickly = (db: MongoDB, gitea: unknown) => new ProjectRepoService(db, gitea as never, KEY as never, undefined, { recordWaitMs: 20, refusals: unexpectedRefusals });

describe('the Gitea user behind an account', () => {
  it('is made once when several runs need it at the same moment', async () => {
    const db = await testDatabase();
    let made = 0;
    const gitea = { createUserAccount: async (username: string) => { made += 1; await new Promise((resolve) => setTimeout(resolve, 20)); return { username, password: 'secret' }; } };
    const repos = new ProjectRepoService(db, gitea as never, KEY as never, undefined, { refusals: unexpectedRefusals });

    const accounts = await Promise.all([repos.ensureAccountFor('space-1'), repos.ensureAccountFor('space-1'), repos.ensureAccountFor('space-1')]);

    expect(made).toBe(1);
    expect(new Set(accounts.map((account) => account.username)).size).toBe(1);
  });

  it('waits for the record when another process made the user first', async () => {
    const db = await testDatabase();
    const theirs = new ProjectRepoService(db, { createUserAccount: async (username: string) => ({ username, password: 'theirs' }) } as never, KEY as never, undefined, { refusals: unexpectedRefusals });
    const gitea = { createUserAccount: async () => { throw new Error('HTTP 500 {"message":"pq: duplicate key value violates unique constraint \\"UQE_user_lower_name\\""}'); } };
    const ours = new ProjectRepoService(db, gitea as never, KEY as never, undefined, { refusals: unexpectedRefusals });

    const waiting = ours.ensureAccountFor('space-2');
    await theirs.ensureAccountFor('space-2');

    expect((await waiting).username).toBe((await theirs.ensureAccountFor('space-2')).username);
  });

  it('takes over a user an earlier attempt made but never recorded, instead of failing forever', async () => {
    const db = await testDatabase();
    const passwords: string[] = [];
    const gitea = {
      createUserAccount: async () => { throw new Error('Failed to create Gitea account koala-space3: HTTP 422 {"message":"user already exists [name: koala-space3]"}'); },
      setUserPassword: async (_username: string, password: string) => { passwords.push(password); },
    };
    const repos = recordingQuickly(db, gitea);

    const [first, second] = await Promise.all([repos.ensureAccountFor('space-3'), recordingQuickly(db, gitea).ensureAccountFor('space-3')]);

    expect(first.username).toBe('koala-space3');
    expect(second.username).toBe('koala-space3');
    const stored = await db.projects.getGiteaAccount('space-3');
    expect(stored?.username).toBe('koala-space3');
    expect(new Set(passwords).size).toBe(1);
    expect((await repos.ensureAccountFor('space-3')).username).toBe('koala-space3');
  });

  it('takes the user over at once when the answer to making it was lost on the way', async () => {
    const db = await testDatabase();
    const passwords: string[] = [];
    const gitea = {
      createUserAccount: async () => { throw new Error('This socket has been ended by the other party'); },
      userExists: async () => true,
      setUserPassword: async (_username: string, password: string) => { passwords.push(password); },
    };
    const repos = recordingQuickly(db, gitea);

    const accounts = await Promise.all([repos.ensureAccountFor('space-4'), repos.ensureAccountFor('space-4'), repos.ensureAccountFor('space-4')]);

    expect(new Set(accounts.map((account) => account.username))).toEqual(new Set(['koala-space4']));
    expect(passwords).toHaveLength(1);
    expect((await db.projects.getGiteaAccount('space-4'))?.username).toBe('koala-space4');
  });

  it('passes on a lost answer when the user was never made', async () => {
    const db = await testDatabase();
    const gitea = {
      createUserAccount: async () => { throw new Error('This socket has been ended by the other party'); },
      userExists: async () => false,
      setUserPassword: async () => undefined,
    };
    await expect(new ProjectRepoService(db, gitea as never, KEY as never, undefined, { refusals: unexpectedRefusals }).ensureAccountFor('space-5')).rejects.toThrow(/ended by the other party/);
    expect(await db.projects.getGiteaAccount('space-5')).toBeNull();
  });
});

describe('making a project with a repository', () => {
  const fakeGitea = (options: { repos?: string[]; failWebhook?: boolean } = {}) => {
    const repos = new Set(options.repos ?? []);
    const calls: string[] = [];
    return {
      calls,
      gitea: {
        createUserAccount: async (username: string) => ({ username, password: 'pw' }),
        findRepo: async (owner: string, name: string) => (repos.has(`${owner}/${name}`) ? { owner, name } : null),
        addRepo: (path: string) => { repos.add(path); },
        createRepoForUser: async (owner: string, name: string) => { calls.push(`repo ${owner}/${name}`); repos.add(`${owner}/${name}`); return {}; },
        replaceWebhook: async (owner: string, name: string, url: string) => { calls.push(`hook ${owner}/${name} ${url}`); if (options.failWebhook) throw new Error('Gitea is down'); },
        seedTemplate: async (owner: string, name: string, files: { path: string }[]) => { calls.push(`seed ${owner}/${name} ${files.map((file) => file.path).join(',')}`); return []; },
      },
    };
  };
  const made = async (gitea: unknown, db?: MongoDB) => {
    const store = db ?? await testDatabase();
    return { db: store, repos: new ProjectRepoService(store, gitea as never, KEY as never, async (id) => `http://10.0.0.5:3001/webhooks/gitea/${id}`, { refusals: unexpectedRefusals }) };
  };

  it('makes the repository, its build webhook and the record, deploying itself to the person\'s own cluster, and lays the starter in last', async () => {
    const { calls, gitea } = fakeGitea();
    const { db, repos } = await made(gitea);
    const project = await repos.createProject('u1', { id: 'p1', name: 'My Shop', repo: 'my-shop', language: 'odoo', autoDeployOnBuild: true, starter: [{ path: 'Dockerfile', content: 'FROM odoo' }] });

    expect(calls).toEqual([matching(/^repo .+\/my-shop$/), matching(/^hook .+\/my-shop http:\/\/10\.0\.0\.5:3001\/webhooks\/gitea\/p1$/), matching(/^seed .+\/my-shop Dockerfile$/)]);
    expect(project).toMatchObject({ id: 'p1', name: 'My Shop', ownerId: 'u1', giteaRepo: 'my-shop', language: 'odoo', appType: 'gitapp', autoDeployOnBuild: true, webhookSecretEnc: anyOf(String) });
    expect(project).not.toHaveProperty('targetClusterId');
    expect((await db.projects.getProjects()).map((entry) => entry.id)).toEqual(['p1']);
  });

  it('finishes what a failed attempt started: the repository it made is kept, and the webhook is made again', async () => {
    const first = fakeGitea({ failWebhook: true });
    const { db, repos } = await made(first.gitea);
    await expect(repos.createProject('u1', { id: 'p1', name: 'My Shop', repo: 'my-shop', autoDeployOnBuild: true })).rejects.toThrow('Gitea is down');
    expect((await db.projects.getProjects())[0]).not.toHaveProperty('webhookSecretEnc');

    const owner = (await db.projects.getProjects())[0]!.giteaOwner!;
    const again = fakeGitea({ repos: [`${owner}/my-shop`] });
    const retried = await (await made(again.gitea, db)).repos.createProject('u1', { id: 'p1', name: 'My Shop', repo: 'my-shop', autoDeployOnBuild: true });
    expect(again.calls).toEqual([`hook ${owner}/my-shop http://10.0.0.5:3001/webhooks/gitea/p1`]);
    expect(retried.webhookSecretEnc).toEqual(anyOf(String));
    expect(await db.projects.getProjects()).toHaveLength(1);
  });

  it('builds from a repository the person already has, without making one, and never from anyone else\'s', async () => {
    const { calls, gitea } = fakeGitea({ repos: ['acme/shop', 'gitea_admin/shop'] });
    const { repos } = await made(gitea);
    const { username } = await repos.ensureAccountFor('u1');
    await expect(repos.createProject('u1', { name: 'Shop', repo: 'shop', existing: true, autoDeployOnBuild: false })).rejects.toThrow('You have no repository called "shop" to use; make it here instead.');
    expect(calls).toEqual([]);
    gitea.addRepo(`${username}/shop`);
    const project = await repos.createProject('u1', { id: 'p2', name: 'Shop', repo: 'shop', existing: true, autoDeployOnBuild: false, targetClusterId: 'k3d-mine' });
    expect(calls).toEqual([`hook ${username}/shop http://10.0.0.5:3001/webhooks/gitea/p2`]);
    expect(project).toMatchObject({ giteaOwner: username, targetClusterId: 'k3d-mine', autoDeployOnBuild: false });
  });

  it('moves the build webhooks of the projects it stored onto where Gitea reaches Koala now, and makes no project twice', async () => {
    const { gitea } = fakeGitea();
    const { db, repos } = await made(gitea);
    const shop = await repos.createProject('u1', { id: 'p1', name: 'Shop', repo: 'shop', autoDeployOnBuild: true });
    await db.projects.saveProject({ id: 'local', name: 'On a machine', ownerId: 'u1', appType: 'local', createdAt: new Date().toISOString() });
    const later = fakeGitea();
    const moved = new ProjectRepoService(db, later.gitea as never, KEY as never, async (id) => `http://instance.nowrinkles.svc.cluster.local/webhooks/gitea/${id}`, { refusals: unexpectedRefusals });

    expect(await moved.repointWebhooks()).toEqual({ repointed: 1 });
    expect(later.calls).toEqual([`hook ${shop.giteaOwner}/shop http://instance.nowrinkles.svc.cluster.local/webhooks/gitea/p1`]);
    expect((await db.projects.getProjects()).map((entry) => entry.id).sort()).toEqual(['local', 'p1']);
  });

  it('refuses a second project on the same repository name, and one with nowhere to send pushes', async () => {
    const { gitea } = fakeGitea();
    const { repos, db } = await made(gitea);
    await repos.createProject('u1', { name: 'Shop', repo: 'shop', autoDeployOnBuild: true });
    await expect(repos.createProject('u1', { name: 'Shop again', repo: 'shop', autoDeployOnBuild: true })).rejects.toThrow('already have a project whose repository is called "shop"');
    await expect(new ProjectRepoService(db, gitea as never, KEY as never, undefined, { refusals: unexpectedRefusals }).createProject('u1', { name: 'x', repo: 'x', autoDeployOnBuild: true })).rejects.toThrow('nothing says where their pushes are sent');
  });
});

const fresh = await emptiedEachTime();

documentsThroughAnAccountBehaviour(() => fresh());

describe('the Gitea tokens a push makes, on a real Gitea', () => {
  let realGitea: RealGitea;
  let gitea: GiteaService;
  let scratch: string;

  beforeAll(async () => {
    realGitea = await startRealGitea();
    scratch = await mkdtemp(path.join(tmpdir(), 'repo-tokens-'));
    const dataDir = path.join(scratch, 'data');
    await mkdir(dataDir);
    await writeFile(path.join(dataDir, '.gitea-admin-password'), realGitea.adminPassword);
    gitea = new GiteaService(KEY as never, { url: realGitea.url }, { dataDir });
  }, 0);

  afterAll(async () => {
    await realGitea.close();
    await rm(scratch, { recursive: true, force: true });
  });

  const tokensOf = async (db: MongoDB, ownerId: string): Promise<string[]> => {
    const account = (await db.projects.getGiteaAccount(ownerId))!;
    const answer = await fetch(`${realGitea.url.replace(/\/$/, '')}/api/v1/users/${account.username}/tokens`, {
      headers: { Authorization: `Basic ${Buffer.from(`${account.username}:${decryptValue(account.passwordEnc, KEY as never)}`).toString('base64')}` },
    });
    return ((await answer.json()) as { name: string }[]).map((token) => token.name);
  };

  const bundled = async (): Promise<string> => {
    const work = await mkdtemp(path.join(scratch, 'work-'));
    const git = (...args: string[]) => execFileSync('git', ['-C', work, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
    git('init', '-q', '-b', 'main');
    await writeFile(path.join(work, 'notes.md'), 'hello\n');
    git('add', '.');
    git('commit', '-q', '-m', 'notes');
    const bundle = path.join(work, 'docs.bundle');
    git('bundle', 'create', bundle, 'main');
    return bundle;
  };

  it('a push token Gitea refuses to revoke is revoked when Gitea answers again', async () => {
    const db = await testDatabase();
    let refusals = 0;
    const flaky = new Proxy(gitea, {
      get(target, key, receiver) {
        if (key === 'revokeUserToken') {
          return async (...args: Parameters<GiteaService['revokeUserToken']>) => {
            if (refusals < 2) {
              refusals += 1;
              throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
            }
            return target.revokeUserToken(...args);
          };
        }
        const value: unknown = Reflect.get(target, key, receiver);
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const repos = new ProjectRepoService(db, flaky, KEY as never, undefined, { again: () => reopening(20), log: () => undefined, refusals: unexpectedRefusals });

    const pushed = await repos.pushDocuments({ ownerId: 'tok-1', repo: 'docs', describe: 'Docs', bundle: await bundled() });
    expect(pushed).toMatchObject({ repo: 'docs' });
    expect(await tokensOf(db, 'tok-1')).toHaveLength(1);

    await vi.waitFor(async () => expect(await db.projects.getTokensToRevoke()).toEqual([]), { timeout: 30_000 });
    expect(refusals).toBe(2);
    expect(await tokensOf(db, 'tok-1')).toEqual([]);
  });

  it('a branch pushed to a new repository becomes its main, is pulled back and compared, and every token used is revoked', async () => {
    const db = await testDatabase();
    const repos = new ProjectRepoService(db, gitea, KEY as never, undefined, { refusals: unexpectedRefusals });
    const work = await mkdtemp(path.join(scratch, 'branch-'));
    const git = (...args: string[]) => execFileSync('git', ['-C', work, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]).toString();
    git('init', '-q', '-b', 'draft');
    await writeFile(path.join(work, 'plan.md'), 'first\n');
    git('add', '.');
    git('commit', '-q', '-m', 'first');
    git('bundle', 'create', path.join(work, 'draft.bundle'), 'draft');

    const first = await repos.pushBranch({ ownerId: 'branch-1', repo: 'plans', describe: 'Plans', bundle: path.join(work, 'draft.bundle'), branch: 'draft' });
    expect(first).toBe(git('rev-parse', 'HEAD').trim());
    const { username } = await repos.ensureAccountFor('branch-1');
    expect(await gitea.getRawFile(username, 'plans', 'plan.md', 'main')).toBe('first\n');

    git('checkout', '-q', '-b', 'next');
    await writeFile(path.join(work, 'plan.md'), 'second\n');
    git('commit', '-q', '-am', 'second');
    git('bundle', 'create', path.join(work, 'next.bundle'), 'next');
    const second = await repos.pushBranch({ ownerId: 'branch-1', repo: 'plans', describe: 'Plans', bundle: path.join(work, 'next.bundle'), branch: 'next' });
    expect(await gitea.getRawFile(username, 'plans', 'plan.md', 'main')).toBe('first\n');

    const branchBack = path.join(work, 'next-back.bundle');
    expect(await repos.pullBranch({ ownerId: 'branch-1', repo: 'plans', branch: 'next', bundle: branchBack })).toBe(true);
    expect(git('bundle', 'list-heads', branchBack)).toContain(`${second} refs/heads/next`);
    expect(await repos.pullBranch({ ownerId: 'branch-1', repo: 'plans', branch: 'gone', bundle: path.join(work, 'gone.bundle') })).toBe(false);

    const allBack = path.join(work, 'all-back.bundle');
    expect(await repos.pullDocuments({ ownerId: 'branch-1', repo: 'plans', bundle: allBack })).toBe(true);
    expect(git('bundle', 'list-heads', allBack)).toEqual(expect.stringContaining(`${first} refs/heads/main`));
    expect(await repos.pullDocuments({ ownerId: 'branch-1', repo: 'nothing-here', bundle: path.join(work, 'none.bundle') })).toBe(false);

    const diff = await repos.diffCommits({ ownerId: 'branch-1', owner: username, repo: 'plans', base: 'main', head: 'next' });
    expect(diff).toContain('-first');
    expect(diff).toContain('+second');

    expect(await tokensOf(db, 'branch-1')).toEqual([]);
    expect(await db.projects.getTokensToRevoke()).toEqual([]);
  });

  it('a token left from a push that failed to revoke is revoked at the next start', async () => {
    const db = await testDatabase();
    const repos = new ProjectRepoService(db, gitea, KEY as never, undefined, { refusals: unexpectedRefusals });
    const { username } = await repos.ensureAccountFor('tok-2');
    const account = (await db.projects.getGiteaAccount('tok-2'))!;
    const left = await gitea.createPushToken(username, decryptValue(account.passwordEnc, KEY as never));
    await db.projects.saveTokenToRevoke({ name: left.name, ownerId: 'tok-2', username, process: 'backend-that-stopped', at: new Date().toISOString() });
    expect(await tokensOf(db, 'tok-2')).toEqual([left.name]);

    expect(await new ProjectRepoService(db, gitea, KEY as never, undefined, { refusals: unexpectedRefusals }).revokeLeftoverTokens([])).toBe(1);

    expect(await tokensOf(db, 'tok-2')).toEqual([]);
    expect(await db.projects.getTokensToRevoke()).toEqual([]);
  });
});
