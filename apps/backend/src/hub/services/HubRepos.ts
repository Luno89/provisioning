import type { GiteaService } from '../../projects/index.js';

export interface HubRepoAccess {
  url: string;
  username: string;
  token: string;
}

export interface HubRepos {
  create(projectId: string): Promise<HubRepoAccess>;
  remove(projectId: string): Promise<void>;
  files(projectId: string): Promise<string[]>;
  read(projectId: string, path: string): Promise<string | null>;
}

export const hubOrgOf = (projectId: string): string => `shared-${projectId}`;
export const hubBotOf = (projectId: string): string => `shared-${projectId}-bot`;
export const HUB_REPO = 'project';

export function giteaHubRepos(gitea: Pick<GiteaService, 'ensureOrg' | 'ensureOrgRepo' | 'letWrite' | 'createUserAccount' | 'createPushToken' | 'deleteUser' | 'deleteRepo' | 'deleteOrg' | 'repoGitUrl' | 'listPaths' | 'getRawFile'>): HubRepos {
  return {
    async create(projectId) {
      const org = hubOrgOf(projectId);
      const bot = hubBotOf(projectId);
      await gitea.ensureOrg(org);
      await gitea.ensureOrgRepo(org, HUB_REPO);
      await gitea.deleteUser(bot);
      const { password } = await gitea.createUserAccount(bot, `${bot}@hub.koala.invalid`);
      await gitea.letWrite(org, HUB_REPO, bot);
      const { token } = await gitea.createPushToken(bot, password);
      return { url: await gitea.repoGitUrl(org, HUB_REPO), username: bot, token };
    },
    async remove(projectId) {
      const org = hubOrgOf(projectId);
      await gitea.deleteRepo(org, HUB_REPO);
      await gitea.deleteUser(hubBotOf(projectId));
      await gitea.deleteOrg(org);
    },
    files: (projectId) => gitea.listPaths(hubOrgOf(projectId), HUB_REPO, 'main'),
    read: (projectId, path) => gitea.getRawFile(hubOrgOf(projectId), HUB_REPO, path.split('/').map(encodeURIComponent).join('/'), 'main'),
  };
}
