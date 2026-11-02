import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { GiteaService } from '../../projects/index.js';
import { giteaHubRepos, hubBotOf, hubOrgOf, HUB_REPO } from './HubRepos.js';

type Gitea = Parameters<typeof giteaHubRepos>[0];

function gitea() {
  const server = mock<Gitea>();
  server.createUserAccount.mockResolvedValue({ password: 'pw' } as Awaited<ReturnType<GiteaService['createUserAccount']>>);
  server.createPushToken.mockResolvedValue({ token: 'tok' } as Awaited<ReturnType<GiteaService['createPushToken']>>);
  server.repoGitUrl.mockResolvedValue('https://git.example/shared-abc/project.git');
  return server;
}

describe('the hub\'s repository for a shared project', () => {
  it('names the organisation and the bot after the project', () => {
    expect([hubOrgOf('abc'), hubBotOf('abc'), HUB_REPO]).toEqual(['shared-abc', 'shared-abc-bot', 'project']);
  });

  it('makes an organisation and a repository, and a bot that can write to it and only it, whose token it hands back', async () => {
    const server = gitea();
    const made = await giteaHubRepos(server).create('abc');
    expect(made).toEqual({ url: 'https://git.example/shared-abc/project.git', username: 'shared-abc-bot', token: 'tok' });
    expect(server.ensureOrg).toHaveBeenCalledWith('shared-abc');
    expect(server.ensureOrgRepo).toHaveBeenCalledWith('shared-abc', 'project');
    expect(server.deleteUser).toHaveBeenCalledWith('shared-abc-bot');
    expect(server.createUserAccount).toHaveBeenCalledWith('shared-abc-bot', 'shared-abc-bot@hub.koala.invalid');
    expect(server.letWrite).toHaveBeenCalledWith('shared-abc', 'project', 'shared-abc-bot');
    expect(server.createPushToken).toHaveBeenCalledWith('shared-abc-bot', 'pw');
  });

  it('sends its pushes to the hub, signed with the project\'s own secret, so the owner\'s instance hears its main moved', async () => {
    const server = gitea();
    await giteaHubRepos(server, { url: async (projectId) => `http://10.0.0.2:3001/webhooks/hub-repo/${projectId}`, secret: (projectId) => `secret-of-${projectId}` }).create('abc');
    expect(server.replaceWebhook).toHaveBeenCalledWith('shared-abc', 'project', 'http://10.0.0.2:3001/webhooks/hub-repo/abc', 'secret-of-abc');
    await giteaHubRepos(gitea()).create('abc');
  });

  it('takes the repository, the bot and the organisation away', async () => {
    const server = gitea();
    await giteaHubRepos(server).remove('abc');
    expect(server.deleteRepo).toHaveBeenCalledWith('shared-abc', 'project');
    expect(server.deleteUser).toHaveBeenCalledWith('shared-abc-bot');
    expect(server.deleteOrg).toHaveBeenCalledWith('shared-abc');
  });

  it('lists the files on main and reads one, escaping each part of its path', async () => {
    const server = gitea();
    server.listPaths.mockResolvedValue(['a.txt']);
    server.getRawFile.mockResolvedValue('hello');
    const repos = giteaHubRepos(server);
    expect(await repos.files('abc')).toEqual(['a.txt']);
    expect(server.listPaths).toHaveBeenCalledWith('shared-abc', 'project', 'main');
    expect(await repos.read('abc', 'dir with space/a#b.txt')).toBe('hello');
    expect(server.getRawFile).toHaveBeenCalledWith('shared-abc', 'project', 'dir%20with%20space/a%23b.txt', 'main');
  });
});
