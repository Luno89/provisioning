import { describe, expect, it, vi } from 'vitest';
import { matches, mock } from 'vitest-mock-extended';
import { containing } from '../../platform/lib/test-matchers.js';
import type { Database } from '../../platform/lib/db-interface.js';
import type { GiteaService } from '../services/GiteaService.js';
import { ProjectRepoService } from '../services/ProjectRepoService.js';
import { reopening } from '@koala/engine-core/reopening';
import type { DependencyRefusals } from '../../platform/lib/dependencies.js';

const KEY = 'a'.repeat(64) as never;

export const unexpectedRefusals: DependencyRefusals = {
  refused: (dependency, reason) => { throw new Error(`${dependency} refused for good, which this test does not expect: ${reason}`); },
};

async function setUp(make: () => Promise<Database>) {
  const db = await make();
  const gitea = mock<GiteaService>();
  gitea.createUserAccount.mockImplementation(async (username) => ({ password: `pw-${username}` }));
  gitea.revokeUserToken.mockResolvedValue(undefined);
  return { db, gitea, repos: new ProjectRepoService(db, gitea, KEY, undefined, { refusals: unexpectedRefusals }) };
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
      const repos = new ProjectRepoService(db, gitea, KEY, undefined, { again: () => reopening(5), log: () => undefined, refusals: unexpectedRefusals });
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

    it('pulls a repository or a branch into a bundle with a read token it revokes afterwards, and pulls nothing from a repository the person lacks', async () => {
      const { db, gitea, repos } = await setUp(make);
      gitea.findRepo.calledWith('koala-u1', 'docs').mockResolvedValue({ owner: 'koala-u1', name: 'docs' });
      gitea.createReadToken.mockResolvedValueOnce({ name: 'read-1', token: 'r1' }).mockResolvedValueOnce({ name: 'read-2', token: 'r2' });
      const tokenIs = (token: string) => matches<{ username: string; token: string }>((auth) => auth.username === 'koala-u1' && auth.token === token);
      gitea.pullBundle.calledWith(tokenIs('r1'), 'koala-u1', 'docs', '/tmp/all.bundle').mockResolvedValue(true);
      gitea.pullBranchBundle.calledWith(tokenIs('r2'), 'koala-u1', 'docs', 'draft', '/tmp/draft.bundle').mockResolvedValue(true);

      expect(await repos.pullDocuments({ ownerId: 'u1', repo: 'docs', bundle: '/tmp/all.bundle' })).toBe(true);
      expect(await repos.pullBranch({ ownerId: 'u1', repo: 'docs', branch: 'draft', bundle: '/tmp/draft.bundle' })).toBe(true);
      expect(gitea.createReadToken).toHaveBeenCalledWith('koala-u1', 'pw-koala-u1');
      expect(gitea.revokeUserToken.mock.calls).toEqual([['koala-u1', 'pw-koala-u1', 'read-1'], ['koala-u1', 'pw-koala-u1', 'read-2']]);
      expect(await db.projects.getTokensToRevoke()).toEqual([]);

      expect(await repos.pullDocuments({ ownerId: 'u1', repo: 'missing', bundle: '/tmp/x.bundle' })).toBe(false);
      expect(await repos.pullBranch({ ownerId: 'u1', repo: 'missing', branch: 'draft', bundle: '/tmp/x.bundle' })).toBe(false);
      expect(gitea.createReadToken).toHaveBeenCalledTimes(2);
    });

    it('pushes a branch with a push token it revokes afterwards, making a new repository\'s main from it and waiting until it serves files', async () => {
      const { db, gitea, repos } = await setUp(make);
      gitea.findRepo.mockResolvedValueOnce(null).mockResolvedValue({ owner: 'koala-u1', name: 'docs' });
      gitea.repoServesFiles.mockResolvedValueOnce(false).mockResolvedValue(true);
      gitea.createPushToken.mockResolvedValueOnce({ name: 'push-1', token: 'p1' }).mockResolvedValueOnce({ name: 'push-2', token: 'p2' });
      gitea.pushBranchBundle.mockResolvedValueOnce('c1').mockResolvedValueOnce('c2');

      expect(await repos.pushBranch({ ownerId: 'u1', repo: 'docs', describe: 'Docs', bundle: '/tmp/b1', branch: 'draft' })).toBe('c1');
      expect(gitea.createRepoForUser).toHaveBeenCalledWith('koala-u1', 'docs', { private: true, description: 'Docs', empty: true });
      expect(gitea.pushBranchBundle).toHaveBeenLastCalledWith({ username: 'koala-u1', token: 'p1' }, 'koala-u1', 'docs', '/tmp/b1', 'draft', { asMain: true });
      expect(gitea.repoServesFiles).toHaveBeenCalledTimes(2);

      expect(await repos.pushBranch({ ownerId: 'u1', repo: 'docs', describe: 'Docs', bundle: '/tmp/b2', branch: 'next' })).toBe('c2');
      expect(gitea.createRepoForUser).toHaveBeenCalledTimes(1);
      expect(gitea.pushBranchBundle).toHaveBeenLastCalledWith({ username: 'koala-u1', token: 'p2' }, 'koala-u1', 'docs', '/tmp/b2', 'next', { asMain: false });
      expect(gitea.repoServesFiles).toHaveBeenCalledTimes(2);
      expect(gitea.revokeUserToken.mock.calls).toEqual([['koala-u1', 'pw-koala-u1', 'push-1'], ['koala-u1', 'pw-koala-u1', 'push-2']]);
      expect(await db.projects.getTokensToRevoke()).toEqual([]);
    });

    it('compares two commits of a repository with a read token it revokes afterwards', async () => {
      const { db, gitea, repos } = await setUp(make);
      gitea.createReadToken.mockResolvedValue({ name: 'read-1', token: 'r1' });
      gitea.diffBetween.calledWith(matches<{ username: string; token: string }>((auth) => auth.token === 'r1'), 'koala-u2', 'shop', 'main', 'draft').mockResolvedValue('+hello\n');

      expect(await repos.diffCommits({ ownerId: 'u1', owner: 'koala-u2', repo: 'shop', base: 'main', head: 'draft' })).toBe('+hello\n');
      expect(gitea.revokeUserToken).toHaveBeenCalledWith('koala-u1', 'pw-koala-u1', 'read-1');
      expect(await db.projects.getTokensToRevoke()).toEqual([]);
    });

    it('tags each token it makes with the pod that made it', async () => {
      const { db, gitea } = await setUp(make);
      const repos = new ProjectRepoService(db, gitea, KEY, undefined, { process: 'luno-backend-5c8d-xyz12', refusals: unexpectedRefusals });
      gitea.findRepo.mockResolvedValue({ owner: 'koala-u1', name: 'docs' });
      gitea.createPushToken.mockResolvedValue({ name: 'push-1', token: 'tok' });
      let keptWhileUsed: unknown;
      gitea.pushBundle.mockImplementation(async () => { keptWhileUsed = await db.projects.getTokensToRevoke(); return 'abc123'; });

      await repos.pushDocuments({ ownerId: 'u1', repo: 'docs', describe: 'Docs', bundle: 'b' });

      expect(keptWhileUsed).toEqual([expect.objectContaining({ name: 'push-1', process: 'luno-backend-5c8d-xyz12' })]);
    });

    it('revokes the tokens of pods Kubernetes no longer has, and a pod\'s tokens the moment Kubernetes says it is gone, leaving a live pod\'s alone', async () => {
      const { db, gitea } = await setUp(make);
      const repos = new ProjectRepoService(db, gitea, KEY, undefined, { again: () => reopening(5), log: () => undefined, refusals: unexpectedRefusals });
      await repos.ensureAccountFor('u1');
      const token = (name: string, process: string) => db.projects.saveTokenToRevoke({ name, ownerId: 'u1', username: 'koala-u1', process, at: '2026-11-17T10:00:00.000Z' });
      await token('push-gone', 'luno-backend-old');
      await token('push-live', 'luno-worker-engine-live');
      let gone: ((pod: string) => void) | undefined;
      const pods = {
        live: async () => ['luno-worker-engine-live'],
        whenGone: async (onGone: (pod: string) => void) => { gone = onGone; return { ended: new Promise<never>(() => undefined), stop: () => undefined }; },
      };

      void repos.keepRevokingLeftovers(pods);
      await vi.waitFor(async () => expect((await db.projects.getTokensToRevoke()).map((kept) => kept.name)).toEqual(['push-live']));
      expect(gone, 'the watch on gone pods was started before the live ones were read').toBeDefined();
      gone!('luno-worker-engine-live');

      await vi.waitFor(async () => expect(await db.projects.getTokensToRevoke()).toEqual([]));
      expect(gitea.revokeUserToken.mock.calls).toEqual([['koala-u1', 'pw-koala-u1', 'push-gone'], ['koala-u1', 'pw-koala-u1', 'push-live']]);
    });

    it('keeps trying to revoke the tokens gone pods left until Kubernetes can be read', async () => {
      const { db, gitea } = await setUp(make);
      const repos = new ProjectRepoService(db, gitea, KEY, undefined, { again: () => reopening(5), log: () => undefined, refusals: unexpectedRefusals });
      await repos.ensureAccountFor('u1');
      await db.projects.saveTokenToRevoke({ name: 'push-gone', ownerId: 'u1', username: 'koala-u1', process: 'luno-backend-old', at: '2026-11-17T10:00:00.000Z' });
      let asked = 0;
      const pods = {
        live: async () => {
          asked += 1;
          if (asked === 1) throw Object.assign(new Error('Unable to connect to the server: dial tcp 10.43.0.1:443: connect: connection refused'), { stderr: 'Unable to connect to the server: dial tcp 10.43.0.1:443: connect: connection refused' });
          return [];
        },
        whenGone: async () => ({ ended: new Promise<never>(() => undefined), stop: () => undefined }),
      };

      void repos.keepRevokingLeftovers(pods);
      await vi.waitFor(async () => expect(await db.projects.getTokensToRevoke()).toEqual([]));
      expect(gitea.revokeUserToken).toHaveBeenCalledWith('koala-u1', 'pw-koala-u1', 'push-gone');
      expect(asked).toBe(2);
    });

    it('holds Gitea as refused, and stops revoking, once Gitea refuses a gone pod\'s token for good', async () => {
      const { db, gitea } = await setUp(make);
      const refused: string[] = [];
      const repos = new ProjectRepoService(db, gitea, KEY, undefined, { again: () => reopening(5), log: () => undefined, refusals: { refused: (dependency, reason) => { refused.push(`${dependency}: ${reason}`); } } });
      await repos.ensureAccountFor('u1');
      await db.projects.saveTokenToRevoke({ name: 'push-gone', ownerId: 'u1', username: 'koala-u1', process: 'luno-backend-old', at: '2026-11-17T10:00:00.000Z' });
      gitea.revokeUserToken.mockRejectedValue(Object.assign(new Error('Gitea would not revoke the token push-gone of koala-u1 (HTTP 403)'), { status: 403 }));
      const pods = { live: async () => [], whenGone: async () => ({ ended: new Promise<never>(() => undefined), stop: () => undefined }) };

      void repos.keepRevokingLeftovers(pods);
      await vi.waitFor(() => expect(refused).toEqual(['gitea: revoking the Gitea tokens gone pods left: it refused the request (403)']));
      expect(gitea.revokeUserToken).toHaveBeenCalledTimes(1);
      expect((await db.projects.getTokensToRevoke()).map((kept) => kept.name)).toEqual(['push-gone']);
    });

    it('revokes the token and rethrows when the push fails, and only warns when revoking fails too', async () => {
      const { gitea, repos } = await setUp(make);
      gitea.findRepo.mockResolvedValue({ owner: 'koala-u1', name: 'docs' });
      gitea.createPushToken.mockResolvedValue({ name: 'push-1', token: 'tok' });
      gitea.pushBundle.mockRejectedValue(new Error('rejected'));
      gitea.revokeUserToken.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await expect(repos.pushDocuments({ ownerId: 'u1', repo: 'docs', describe: 'Docs', bundle: 'b' })).rejects.toThrow('rejected');
      expect(gitea.revokeUserToken).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(containing('the Gitea token push-1 of koala-u1 is still valid'));
      warn.mockRestore();
    });
  });
}
