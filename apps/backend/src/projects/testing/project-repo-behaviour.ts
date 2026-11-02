import { describe, expect, it, vi } from 'vitest';
import { matches, mock } from 'vitest-mock-extended';
import { containing } from '../../platform/lib/test-matchers.js';
import type { Database } from '../../platform/lib/db-interface.js';
import type { GiteaService } from '../services/GiteaService.js';
import { ProjectRepoService } from '../services/ProjectRepoService.js';

const KEY = 'a'.repeat(64) as never;

async function setUp(make: () => Promise<Database>) {
  const db = await make();
  const gitea = mock<GiteaService>();
  gitea.createUserAccount.mockImplementation(async (username) => ({ password: `pw-${username}` }));
  gitea.revokeUserToken.mockResolvedValue(undefined);
  return { db, gitea, repos: new ProjectRepoService(db, gitea, KEY) };
}

export function documentsThroughAnAccountBehaviour(make: () => Promise<Database>): void {
  describe('the documents pushed and the tokens revoked through a person\'s Gitea account', () => {
    it('revokes a checkout token with the account\'s own password, and nothing for a person with no account', async () => {
      const { gitea, repos } = await setUp(make);
      await repos.revokeCheckout('nobody', 'tok');
      expect(gitea.revokeUserToken).not.toHaveBeenCalled();
      await repos.ensureAccountFor('u1');
      await repos.revokeCheckout('u1', 'tok');
      expect(gitea.revokeUserToken).toHaveBeenCalledWith('koala-u1', 'pw-koala-u1', 'tok');
    });

    it('pushes a bundle with a token it revokes afterwards, making the repository first when it is new', async () => {
      const { db, gitea, repos } = await setUp(make);
      gitea.findRepo.mockResolvedValue(null);
      gitea.repoServesFiles.mockResolvedValueOnce(false).mockResolvedValue(true);
      gitea.createPushToken.mockResolvedValue({ name: 'push-1', token: 'tok' });
      gitea.pushBundle.calledWith(matches<{ username: string; token: string }>((auth) => auth.username === 'koala-u1' && auth.token === 'tok'), 'koala-u1', 'docs', '/tmp/b.bundle').mockResolvedValue('abc123');
      expect(await repos.pushDocuments({ ownerId: 'u1', repo: 'docs', describe: 'Docs', bundle: '/tmp/b.bundle' })).toEqual({ owner: 'koala-u1', repo: 'docs', commit: 'abc123' });
      expect(gitea.createRepoForUser).toHaveBeenCalledWith('koala-u1', 'docs', { private: true, description: 'Docs', empty: true });
      expect(gitea.repoServesFiles).toHaveBeenCalledTimes(2);
      expect(gitea.revokeUserToken).toHaveBeenCalledWith('koala-u1', 'pw-koala-u1', 'push-1');
      expect((await db.projects.getGiteaAccount('u1'))?.username).toBe('koala-u1');
    });

    it('revokes the token and rethrows when the push fails, and only warns when revoking fails too', async () => {
      const { gitea, repos } = await setUp(make);
      gitea.findRepo.mockResolvedValue({ owner: 'koala-u1', name: 'docs' });
      gitea.createPushToken.mockResolvedValue({ name: 'push-1', token: 'tok' });
      gitea.pushBundle.mockRejectedValue(new Error('rejected'));
      gitea.revokeUserToken.mockRejectedValue(new Error('gitea down'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await expect(repos.pushDocuments({ ownerId: 'u1', repo: 'docs', describe: 'Docs', bundle: 'b' })).rejects.toThrow('rejected');
      expect(gitea.revokeUserToken).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(containing('the Gitea token push-1 of koala-u1 is still valid'));
      warn.mockRestore();
    });
  });
}
