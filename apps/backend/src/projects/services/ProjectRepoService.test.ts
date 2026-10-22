import { describe, it, expect } from 'vitest';
import { testDatabase } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import { ProjectRepoService } from './ProjectRepoService.js';

const KEY = 'a'.repeat(64);

describe('the Gitea user behind an account', () => {
  it('is made once when several runs need it at the same moment', async () => {
    const db = await testDatabase();
    let made = 0;
    const gitea = { createUserAccount: async (username: string) => { made += 1; await new Promise((resolve) => setTimeout(resolve, 20)); return { username, password: 'secret' }; } };
    const repos = new ProjectRepoService(db, gitea as never, KEY as never);

    const accounts = await Promise.all([repos.ensureAccountFor('space-1'), repos.ensureAccountFor('space-1'), repos.ensureAccountFor('space-1')]);

    expect(made).toBe(1);
    expect(new Set(accounts.map((account) => account.username)).size).toBe(1);
  });

  it('waits for the record when another process made the user first', async () => {
    const db = await testDatabase();
    const theirs = new ProjectRepoService(db, { createUserAccount: async (username: string) => ({ username, password: 'theirs' }) } as never, KEY as never);
    const gitea = { createUserAccount: async () => { throw new Error('HTTP 500 {"message":"pq: duplicate key value violates unique constraint \\"UQE_user_lower_name\\""}'); } };
    const ours = new ProjectRepoService(db, gitea as never, KEY as never);

    const waiting = ours.ensureAccountFor('space-2');
    await theirs.ensureAccountFor('space-2');

    expect((await waiting).username).toBe((await theirs.ensureAccountFor('space-2')).username);
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
        getRepo: async (owner: string, name: string) => { if (!repos.has(`${owner}/${name}`)) throw new Error('not found'); return {}; },
        createRepoForUser: async (owner: string, name: string) => { calls.push(`repo ${owner}/${name}`); repos.add(`${owner}/${name}`); return {}; },
        replaceWebhook: async (owner: string, name: string, url: string) => { calls.push(`hook ${owner}/${name} ${url}`); if (options.failWebhook) throw new Error('Gitea is down'); },
        seedTemplate: async (owner: string, name: string, files: { path: string }[]) => { calls.push(`seed ${owner}/${name} ${files.map((file) => file.path).join(',')}`); return []; },
      },
    };
  };
  const made = async (gitea: unknown, db?: MongoDB) => {
    const store = db ?? await testDatabase();
    return { db: store, repos: new ProjectRepoService(store, gitea as never, KEY as never, async (id) => `http://10.0.0.5:3001/webhooks/gitea/${id}`) };
  };

  it('makes the repository, its build webhook and the record, deploying itself to the person\'s own cluster, and lays the starter in last', async () => {
    const { calls, gitea } = fakeGitea();
    const { db, repos } = await made(gitea);
    const project = await repos.createProject('u1', { id: 'p1', name: 'My Shop', repo: 'my-shop', language: 'odoo', autoDeployOnBuild: true, starter: [{ path: 'Dockerfile', content: 'FROM odoo' }] });

    expect(calls).toEqual([expect.stringMatching(/^repo .+\/my-shop$/), expect.stringMatching(/^hook .+\/my-shop http:\/\/10\.0\.0\.5:3001\/webhooks\/gitea\/p1$/), expect.stringMatching(/^seed .+\/my-shop Dockerfile$/)]);
    expect(project).toMatchObject({ id: 'p1', name: 'My Shop', ownerId: 'u1', giteaRepo: 'my-shop', language: 'odoo', appType: 'gitapp', targetClusterId: 'provisioning-lunorica', autoDeployOnBuild: true, webhookSecretEnc: expect.any(String) });
    expect((await db.getProjects()).map((entry) => entry.id)).toEqual(['p1']);
  });

  it('finishes what a failed attempt started: the repository it made is kept, and the webhook is made again', async () => {
    const first = fakeGitea({ failWebhook: true });
    const { db, repos } = await made(first.gitea);
    await expect(repos.createProject('u1', { id: 'p1', name: 'My Shop', repo: 'my-shop', autoDeployOnBuild: true })).rejects.toThrow('Gitea is down');
    expect((await db.getProjects())[0]).not.toHaveProperty('webhookSecretEnc');

    const owner = (await db.getProjects())[0]!.giteaOwner!;
    const again = fakeGitea({ repos: [`${owner}/my-shop`] });
    const retried = await (await made(again.gitea, db)).repos.createProject('u1', { id: 'p1', name: 'My Shop', repo: 'my-shop', autoDeployOnBuild: true });
    expect(again.calls).toEqual([`hook ${owner}/my-shop http://10.0.0.5:3001/webhooks/gitea/p1`]);
    expect(retried.webhookSecretEnc).toEqual(expect.any(String));
    expect(await db.getProjects()).toHaveLength(1);
  });

  it('builds from a repository someone already has, without making one', async () => {
    const { calls, gitea } = fakeGitea({ repos: ['acme/shop'] });
    const { repos } = await made(gitea);
    const project = await repos.createProject('u1', { name: 'Shop', repo: 'shop', existingOwner: 'acme', autoDeployOnBuild: false, targetClusterId: 'k3d-mine' });
    expect(calls).toEqual([expect.stringMatching(/^hook acme\/shop /)]);
    expect(project).toMatchObject({ giteaOwner: 'acme', targetClusterId: 'k3d-mine', autoDeployOnBuild: false });
  });

  it('refuses a second project on the same repository name, and one with nowhere to send pushes', async () => {
    const { gitea } = fakeGitea();
    const { repos, db } = await made(gitea);
    await repos.createProject('u1', { name: 'Shop', repo: 'shop', autoDeployOnBuild: true });
    await expect(repos.createProject('u1', { name: 'Shop again', repo: 'shop', autoDeployOnBuild: true })).rejects.toThrow('already have a project whose repository is called "shop"');
    await expect(new ProjectRepoService(db, gitea as never, KEY as never).createProject('u1', { name: 'x', repo: 'x', autoDeployOnBuild: true })).rejects.toThrow('nothing says where their pushes are sent');
  });
});
