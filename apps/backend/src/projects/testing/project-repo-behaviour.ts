import { describe, expect, it, vi } from 'vitest';
import { matches, mock } from 'vitest-mock-extended';
import { containing } from '../../platform/lib/test-matchers.js';
import type { Database } from '../../platform/lib/db-interface.js';
import type { GiteaService } from '../services/GiteaService.js';
import { ProjectRepoService } from '../services/ProjectRepoService.js';
import { reopening } from '@koala/engine-core/reopening';

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

    it('a push token Gitea refuses to revoke is revoked when Gitea answers again', async () => {
      const { db, gitea } = await setUp(make);
      const repos = new ProjectRepoService(db, gitea, KEY, undefined, { again: () => reopening(5), log: () => undefined });
      gitea.findRepo.mockResolvedValue({ owner: 'koala-u1', name: 'docs' });
      gitea.createPushToken.mockResolvedValue({ name: 'push-1', token: 'tok' });
      let keptWhileUsed: unknown;
      gitea.pushBundle.mockImplementation(async () => { keptWhileUsed = await db.projects.getTokensToRevoke(); return 'abc123'; });
      const down = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      gitea.revokeUserToken.mockReset();
      gitea.revokeUserToken.mockRejectedValueOnce(down).mockRejectedValueOnce(down).mockResolvedValue(undefined);

      expect(await repos.pushDocuments({ ownerId: 'u1', repo: 'docs', describe: 'Docs', bundle: 'b' })).toMatchObject({ commit: 'abc123' });
      expect(keptWhileUsed).toEqual([expect.objectContaining({ name: 'push-1', username: 'koala-u1', ownerId: 'u1' })]);
      expect(await db.projects.getTokensToRevoke()).toHaveLength(1);

      await vi.waitFor(async () => expect(await db.projects.getTokensToRevoke()).toEqual([]));
      expect(gitea.revokeUserToken).toHaveBeenCalledTimes(3);
      expect(gitea.revokeUserToken).toHaveBeenLastCalledWith('koala-u1', 'pw-koala-u1', 'push-1');
    });

    it('a token left from a push that failed to revoke is revoked at the next start', async () => {
      const { db, gitea, repos } = await setUp(make);
      await repos.ensureAccountFor('u1');
      await db.projects.saveTokenToRevoke({ name: 'push-gone', ownerId: 'u1', username: 'koala-u1', process: 'backend-gone', at: '2026-11-17T10:00:00.000Z' });
      await db.projects.saveTokenToRevoke({ name: 'push-live', ownerId: 'u1', username: 'koala-u1', process: 'worker-engine-live', at: '2026-11-17T10:00:00.000Z' });

      expect(await repos.revokeLeftoverTokens(['worker-engine-live'])).toBe(1);

      expect(gitea.revokeUserToken).toHaveBeenCalledTimes(1);
      expect(gitea.revokeUserToken).toHaveBeenCalledWith('koala-u1', 'pw-koala-u1', 'push-gone');
      expect((await db.projects.getTokensToRevoke()).map((token) => token.name)).toEqual(['push-live']);
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
