import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { decryptValue } from '../../platform/lib/crypto.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import type { GiteaService } from './GiteaService.js';
import { documentsThroughAnAccountBehaviour } from '../testing/project-repo-behaviour.js';
import { ProjectRepoService } from './ProjectRepoService.js';

const KEY = 'a'.repeat(64) as never;
const webhook = async (id: string) => `http://10.0.0.5:3001/webhooks/gitea/${id}`;

function setUp(options: { webhook?: typeof webhook | undefined; recordWaitMs?: number; defaultCluster?: string | undefined } = {}) {
  const db = memoryDatabase();
  const gitea = mock<GiteaService>();
  gitea.createUserAccount.mockImplementation(async (username) => ({ password: `pw-${username}` }));
  gitea.revokeUserToken.mockResolvedValue(undefined);
  const make = (withDb = db, withGitea: GiteaService = gitea) => new ProjectRepoService(withDb, withGitea, KEY, 'webhook' in options ? options.webhook : webhook, { ...(options.recordWaitMs === undefined ? {} : { recordWaitMs: options.recordWaitMs }), ...(options.defaultCluster ? { defaultCluster: options.defaultCluster } : {}) });
  return { db, gitea, repos: make(), make };
}

describe('the Gitea user behind an account', () => {
  it('is made with a name from the owner and a password only Koala keeps, sealed', async () => {
    const { db, gitea, repos } = setUp();
    expect(await repos.ensureAccountFor('space-1')).toEqual({ username: 'koala-space1' });
    expect(gitea.createUserAccount).toHaveBeenCalledWith('koala-space1', 'koala-space1@koala.local');
    const stored = await db.projects.getGiteaAccount('space-1');
    expect(stored).toMatchObject({ ownerId: 'space-1', username: 'koala-space1' });
    expect(stored?.passwordEnc).not.toContain('pw-koala-space1');
    expect(decryptValue(stored!.passwordEnc, KEY)).toBe('pw-koala-space1');
  });

  it('is made once when several runs need it at the same moment, and reused afterwards', async () => {
    const { gitea, repos } = setUp();
    gitea.createUserAccount.mockImplementation(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); return { password: 'secret' }; });
    const accounts = await Promise.all([repos.ensureAccountFor('space-1'), repos.ensureAccountFor('space-1'), repos.ensureAccountFor('space-1')]);
    await repos.ensureAccountFor('space-1');
    expect(gitea.createUserAccount).toHaveBeenCalledTimes(1);
    expect(new Set(accounts.map((account) => account.username))).toEqual(new Set(['koala-space1']));
  });

  it('is tried again after a failure rather than remembering it', async () => {
    const { gitea, repos } = setUp();
    gitea.createUserAccount.mockRejectedValueOnce(new Error('Failed to create Gitea account: HTTP 503 down'));
    await expect(repos.ensureAccountFor('space-1')).rejects.toThrow('HTTP 503');
    expect((await repos.ensureAccountFor('space-1')).username).toBe('koala-space1');
  });

  it('waits for the record when another process made the user first', async () => {
    vi.useFakeTimers();
    try {
      const { db, gitea, repos, make } = setUp({ recordWaitMs: 2_000 });
      gitea.createUserAccount.mockRejectedValue(new Error('HTTP 500 {"message":"pq: duplicate key value violates unique constraint \\"UQE_user_lower_name\\""}'));
      const waiting = repos.ensureAccountFor('space-2');
      const theirGitea = mock<GiteaService>();
      theirGitea.createUserAccount.mockResolvedValue({ password: 'theirs' });
      await make(db, theirGitea).ensureAccountFor('space-2');
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await waiting).username).toBe('koala-space2');
      expect(gitea.setUserPassword).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('takes over a user an earlier attempt made but never recorded, once, instead of failing forever', async () => {
    const { db, gitea, repos, make } = setUp({ recordWaitMs: 20 });
    gitea.createUserAccount.mockRejectedValue(new Error('Failed to create Gitea account koala-space3: HTTP 422 {"message":"user already exists [name: koala-space3]"}'));
    const passwords: string[] = [];
    gitea.setUserPassword.mockImplementation(async (_username, password) => { passwords.push(password); });
    const [first, second] = await Promise.all([repos.ensureAccountFor('space-3'), make().ensureAccountFor('space-3')]);
    expect([first.username, second.username]).toEqual(['koala-space3', 'koala-space3']);
    expect((await db.projects.getGiteaAccount('space-3'))?.username).toBe('koala-space3');
    expect(new Set(passwords).size).toBe(1);
  });

  it('takes the user over at once when the answer to making it was lost on the way', async () => {
    const { db, gitea, repos } = setUp({ recordWaitMs: 20 });
    gitea.createUserAccount.mockRejectedValue(new Error('This socket has been ended by the other party'));
    gitea.userExists.mockResolvedValue(true);
    const accounts = await Promise.all([repos.ensureAccountFor('space-4'), repos.ensureAccountFor('space-4')]);
    expect(new Set(accounts.map((account) => account.username))).toEqual(new Set(['koala-space4']));
    expect(gitea.setUserPassword).toHaveBeenCalledTimes(1);
    expect((await db.projects.getGiteaAccount('space-4'))?.username).toBe('koala-space4');
  });

  it('passes on a lost answer when the user was never made', async () => {
    const { db, gitea, repos } = setUp();
    gitea.createUserAccount.mockRejectedValue(new Error('This socket has been ended by the other party'));
    gitea.userExists.mockResolvedValue(false);
    await expect(repos.ensureAccountFor('space-5')).rejects.toThrow(/ended by the other party/);
    expect(await db.projects.getGiteaAccount('space-5')).toBeNull();
  });

  it('passes on a refusal that is not a duplicate', async () => {
    const { gitea, repos } = setUp();
    gitea.createUserAccount.mockRejectedValue(new Error('Failed to create Gitea account: HTTP 403 forbidden'));
    await expect(repos.ensureAccountFor('space-6')).rejects.toThrow('HTTP 403');
    expect(gitea.setUserPassword).not.toHaveBeenCalled();
  });
});

describe('a project with no repository', () => {
  it('is registered as a local project with a name, a language and where it runs', async () => {
    const { db, repos } = setUp();
    const project = await repos.register('ann', '  Laptop  ', { language: 'node', executionTarget: { kind: 'local-device', deviceId: 'dev-1' } });
    expect(project).toMatchObject({ name: 'Laptop', ownerId: 'ann', language: 'node', appType: 'local', executionTarget: { kind: 'local-device', deviceId: 'dev-1' } });
    expect((await db.projects.getProjects()).map((entry) => entry.id)).toEqual([project.id]);
  });

  it('is named "project" when the name is blank, and carries no language or target nobody gave', async () => {
    const { repos } = setUp();
    const project = await repos.register('ann', '   ');
    expect(project.name).toBe('project');
    expect(project).not.toHaveProperty('language');
    expect(project).not.toHaveProperty('executionTarget');
  });

  it('is refused past the limit of projects a person may have', async () => {
    const { db, repos } = setUp();
    for (let index = 0; index < 50; index += 1) await db.projects.saveProject({ id: `p${index}`, name: `p${index}`, ownerId: 'ann', appType: 'local', createdAt: 't' });
    await expect(repos.register('ann', 'one more')).rejects.toThrow('You already have 50 projects (limit 50).');
    await expect(repos.register('bo', 'fine')).resolves.toMatchObject({ ownerId: 'bo' });
  });

  it('is removed with its records, and unlinked from its trees, when its machine is removed', async () => {
    const { db, repos } = setUp();
    const target = { kind: 'local-device' as const, deviceId: 'dev-1' };
    await db.projects.saveProject({ id: 'local', name: 'L', ownerId: 'ann', appType: 'local', executionTarget: target, createdAt: 't' });
    await db.projects.saveProject({ id: 'other-device', name: 'O', ownerId: 'ann', appType: 'local', executionTarget: { kind: 'local-device', deviceId: 'dev-2' }, createdAt: 't' });
    await db.projects.saveProject({ id: 'theirs', name: 'T', ownerId: 'bo', appType: 'local', executionTarget: target, createdAt: 't' });
    await db.projects.saveProject({ id: 'repo-backed', name: 'R', ownerId: 'ann', appType: 'gitapp', giteaOwner: 'o', giteaRepo: 'r', executionTarget: target, createdAt: 't' });
    await db.projects.saveTree({ id: 't1', ownerId: 'ann', name: 'T', type: 'api-service', projectIds: ['local', 'other-device'], createdAt: 't', updatedAt: 't' });
    await repos.removeFor('ann', 'dev-1');
    expect((await db.projects.getProjects()).map((entry) => entry.id).sort()).toEqual(['other-device', 'repo-backed', 'theirs']);
    expect((await db.projects.getTrees())[0]?.projectIds).toEqual(['other-device']);
  });

  it('is nothing to remove when the machine made none', async () => {
    const { db, repos } = setUp();
    await db.projects.saveProject({ id: 'kept', name: 'K', ownerId: 'ann', appType: 'local', createdAt: 't' });
    await repos.removeFor('ann', 'dev-1');
    expect(await db.projects.getProjects()).toHaveLength(1);
  });
});

describe('pointing every project\'s build webhook at where Gitea reaches Koala now', () => {
  it('moves each project with a repository and a webhook onto the current address, with its own secret, and leaves the rest alone', async () => {
    const { db, gitea, repos } = setUp();
    gitea.findRepo.mockResolvedValue(null);
    const made = await repos.createProject('u1', { id: 'p1', name: 'Shop', repo: 'shop', autoDeployOnBuild: true });
    await db.projects.saveProject({ id: 'local', name: 'L', ownerId: 'u1', appType: 'local', createdAt: 't' });
    await db.projects.saveProjectInfo({ ...made, id: 'going', giteaRepo: 'going', removal: { startedAt: 't', requestedBy: 'u1' } });
    gitea.replaceWebhook.mockClear();
    expect(await repos.repointWebhooks()).toEqual({ repointed: 1 });
    expect(gitea.replaceWebhook).toHaveBeenCalledTimes(1);
    expect(gitea.replaceWebhook).toHaveBeenCalledWith('koala-u1', 'shop', 'http://10.0.0.5:3001/webhooks/gitea/p1', decryptValue(made.webhookSecretEnc!, KEY));
  });

  it('moves nothing where Koala has no webhook address', async () => {
    const { gitea, make } = setUp({ webhook: undefined });
    expect(await make().repointWebhooks()).toEqual({ repointed: 0 });
    expect(gitea.replaceWebhook).not.toHaveBeenCalled();
  });
});

describe('making a project with a repository', () => {
  it('makes the repository, its build webhook and the record, deploying itself to the cluster Koala runs in unless told otherwise, and lays the starter in last', async () => {
    const { db, gitea, repos } = setUp({ defaultCluster: 'machine-koala' });
    gitea.findRepo.mockResolvedValue(null);
    const project = await repos.createProject('u1', { id: 'p1', name: ' My Shop ', repo: 'My Shop', language: 'odoo', autoDeployOnBuild: true, description: 'A shop', starter: [{ path: 'Dockerfile', content: 'FROM odoo' }] });
    expect(project).toMatchObject({ id: 'p1', name: 'My Shop', ownerId: 'u1', giteaOwner: 'koala-u1', giteaRepo: 'my-shop', language: 'odoo', appType: 'gitapp', targetClusterId: 'machine-koala', autoDeployOnBuild: true });
    expect(decryptValue(project.webhookSecretEnc!, KEY)).toMatch(/^[0-9a-f]{64}$/);
    expect(gitea.createRepoForUser).toHaveBeenCalledWith('koala-u1', 'my-shop', { private: true, description: 'A shop' });
    expect(gitea.replaceWebhook).toHaveBeenCalledWith('koala-u1', 'my-shop', 'http://10.0.0.5:3001/webhooks/gitea/p1', decryptValue(project.webhookSecretEnc!, KEY));
    expect(gitea.seedTemplate).toHaveBeenCalledWith('koala-u1', 'my-shop', [{ path: 'Dockerfile', content: 'FROM odoo' }]);
    expect((await db.projects.getProjects()).map((entry) => entry.id)).toEqual(['p1']);
  });

  it('names the project for its repository when no name is given, and keeps the cluster and extras it was given', async () => {
    const { gitea, repos } = setUp();
    gitea.findRepo.mockResolvedValue(null);
    const project = await repos.createProject('u1', { name: '  ', repo: 'shop', autoDeployOnBuild: false, targetClusterId: 'k3d-mine', extra: { executionApproval: 'auto' } });
    expect(project).toMatchObject({ name: 'shop', targetClusterId: 'k3d-mine', autoDeployOnBuild: false, executionApproval: 'auto' });
    expect(gitea.createRepoForUser).toHaveBeenCalledWith('koala-u1', 'shop', { private: true });
    expect(gitea.seedTemplate).not.toHaveBeenCalled();
  });

  it('leaves a repository that exists alone', async () => {
    const { gitea, repos } = setUp();
    gitea.findRepo.mockResolvedValue({ owner: 'koala-u1', name: 'shop' });
    await repos.createProject('u1', { name: 'Shop', repo: 'shop', autoDeployOnBuild: true });
    expect(gitea.createRepoForUser).not.toHaveBeenCalled();
  });

  it('finishes what a failed attempt started: the project is kept, and the webhook is made again', async () => {
    const { db, gitea, repos } = setUp();
    gitea.findRepo.mockResolvedValue(null);
    gitea.replaceWebhook.mockRejectedValueOnce(new Error('Gitea is down'));
    await expect(repos.createProject('u1', { id: 'p1', name: 'My Shop', repo: 'my-shop', autoDeployOnBuild: true })).rejects.toThrow('Gitea is down');
    expect((await db.projects.getProjects())[0]).not.toHaveProperty('webhookSecretEnc');

    gitea.findRepo.mockResolvedValue({ owner: 'koala-u1', name: 'my-shop' });
    gitea.createRepoForUser.mockClear();
    const retried = await repos.createProject('u1', { id: 'p1', name: 'My Shop', repo: 'my-shop', autoDeployOnBuild: true });
    expect(gitea.createRepoForUser).not.toHaveBeenCalled();
    expect(gitea.replaceWebhook).toHaveBeenCalledTimes(2);
    expect(retried.webhookSecretEnc).toBeDefined();
    expect(await db.projects.getProjects()).toHaveLength(1);
  });

  it('returns a finished project as it is, and lays a starter on it when one is given', async () => {
    const { gitea, repos } = setUp();
    gitea.findRepo.mockResolvedValue(null);
    const made = await repos.createProject('u1', { id: 'p1', name: 'Shop', repo: 'shop', autoDeployOnBuild: true });
    gitea.replaceWebhook.mockClear();
    expect(await repos.createProject('u1', { id: 'p1', name: 'Shop', repo: 'shop', autoDeployOnBuild: true })).toEqual(made);
    expect(gitea.replaceWebhook).not.toHaveBeenCalled();
    await repos.createProject('u1', { id: 'p1', name: 'Shop', repo: 'shop', autoDeployOnBuild: true, starter: [{ path: 'a', content: 'b' }] });
    expect(gitea.seedTemplate).toHaveBeenCalledWith('koala-u1', 'shop', [{ path: 'a', content: 'b' }]);
    expect(gitea.replaceWebhook).not.toHaveBeenCalled();
  });

  it('builds from a repository the person already has, without making one, and never from anyone else\'s', async () => {
    const { gitea, repos } = setUp();
    gitea.findRepo.calledWith('koala-u1', 'shop').mockResolvedValueOnce(null);
    await expect(repos.createProject('u1', { name: 'Shop', repo: 'shop', existing: true, autoDeployOnBuild: false })).rejects.toThrow('You have no repository called "shop" to use; make it here instead.');
    expect(gitea.replaceWebhook).not.toHaveBeenCalled();
    gitea.findRepo.calledWith('koala-u1', 'shop').mockResolvedValue({ owner: 'koala-u1', name: 'shop' });
    const project = await repos.createProject('u1', { id: 'p2', name: 'Shop', repo: 'shop', existing: true, autoDeployOnBuild: false });
    expect(project).toMatchObject({ giteaOwner: 'koala-u1', giteaRepo: 'shop' });
    expect(gitea.createRepoForUser).not.toHaveBeenCalled();
  });

  it('refuses a second project on the same repository name, and one with nowhere to send pushes', async () => {
    const { gitea, repos } = setUp();
    gitea.findRepo.mockResolvedValue(null);
    await repos.createProject('u1', { name: 'Shop', repo: 'shop', autoDeployOnBuild: true });
    await expect(repos.createProject('u1', { name: 'Shop again', repo: 'shop', autoDeployOnBuild: true })).rejects.toThrow('already have a project whose repository is called "shop"');
    const nowhere = setUp({ webhook: undefined });
    await expect(nowhere.repos.createProject('u1', { name: 'x', repo: 'x', autoDeployOnBuild: true })).rejects.toThrow('nothing says where their pushes are sent');
  });

  it('refuses a project id that is someone else\'s', async () => {
    const { db, repos } = setUp();
    await db.projects.saveProject({ id: 'p1', name: 'Theirs', ownerId: 'bo', giteaOwner: 'koala-bo', giteaRepo: 'theirs', appType: 'gitapp', createdAt: 't' });
    await expect(repos.createProject('ann', { id: 'p1', name: 'Mine', repo: 'mine', autoDeployOnBuild: true })).rejects.toThrow('project p1 belongs to someone else');
  });

  it('is refused past the limit of projects a person may have', async () => {
    const { db, gitea, repos } = setUp();
    for (let index = 0; index < 50; index += 1) await db.projects.saveProject({ id: `p${index}`, name: `p${index}`, ownerId: 'ann', appType: 'local', createdAt: 't' });
    await expect(repos.createProject('ann', { name: 'one more', repo: 'more', autoDeployOnBuild: true })).rejects.toThrow('limit 50');
    expect(gitea.createUserAccount).not.toHaveBeenCalled();
  });
});

describe('the other things done through a person\'s Gitea account', () => {
  it('writes a document into the project\'s repository, or says it has none', async () => {
    const { gitea, repos } = setUp();
    gitea.ensureFile.calledWith('koala-u1', 'shop', 'PLAN.md', '# plan', 'Add plan').mockResolvedValue(true);
    expect(await repos.writeDocument({ giteaOwner: 'koala-u1', giteaRepo: 'shop' }, 'PLAN.md', '# plan', 'Add plan')).toBe(true);
    await expect(repos.writeDocument({}, 'PLAN.md', 'x', 'm')).rejects.toThrow('This project has no repository to write a document to.');
  });
});

documentsThroughAnAccountBehaviour(async () => memoryDatabase());
