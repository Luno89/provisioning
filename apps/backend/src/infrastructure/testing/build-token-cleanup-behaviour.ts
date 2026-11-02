import { beforeEach, describe, expect, it } from 'vitest';
import type { ClusterMetadata, DeploymentMetadata } from '../../platform/index.js';
import type { Database } from '../../platform/lib/db-interface.js';
import { runOnce } from '../../platform/lib/migrations.js';
import { BUILD_TOKENS_MIGRATION, BuildTokensWait, cleanUpBuildTokens, type BuildTokenCleanupDeps } from '../services/build-token-cleanup.js';

const OWNER = 'owner-1';

const cluster = (id: string) => ({ id, name: id, provider: 'k3d', status: 'healthy', ownerId: OWNER }) as ClusterMetadata;
const app = (name: string, appType: string, clusterId = 'system', extra: Partial<DeploymentMetadata> = {}) =>
  ({ id: name, name, appType, clusterId, strategy: 'helm', status: 'running', ownerId: OWNER, namespace: `${name}-abc123`, ...extra }) as DeploymentMetadata;

export function buildTokenCleanupBehaviour(make: () => Promise<Database>): void {
  describe('the build tokens Koala never revoked', () => {
    let db: Database;

    beforeEach(async () => {
      db = await make();
      for (const entry of [cluster('system'), cluster('mine')]) await db.infrastructure.saveCluster(entry);
      for (const entry of [app('shop', 'gitapp'), app('books', 'audiobookshelf'), app('api', 'gitapp', 'mine'), app('old', 'gitapp', 'system', { status: 'destroying' })]) await db.infrastructure.saveDeployment(entry);
    });

    function world(over: Partial<BuildTokenCleanupDeps> = {}) {
      const written: string[] = [];
      const revoked: string[] = [];
      const deps: BuildTokenCleanupDeps = {
        deployments: () => db.infrastructure.getDeployments(),
        clusterOf: async (id) => (await db.infrastructure.getClusters()).find((entry) => entry.id === id),
        kubeconfigOf: async (entry) => `/tmp/kubeconfig-${entry.id}`,
        writePullSecret: async (namespace, kubeconfig) => { written.push(`${namespace}@${kubeconfig}`); },
        runningBuilds: async () => 0,
        buildTokens: async () => ['build-1a2b', 'build-3c4d'],
        revoke: async (name) => { revoked.push(name); },
        ...over,
      };
      return { deps, written, revoked };
    }

    it('move every git-built app onto the read-only pull login first, then are all revoked, once', async () => {
      const { deps, written, revoked } = world();
      expect(await runOnce(db.platform, BUILD_TOKENS_MIGRATION, 'now', () => cleanUpBuildTokens(deps))).toEqual({ pullSecretsRewritten: 2, buildTokensRevoked: 2 });
      expect([...written].sort()).toEqual(['api-abc123@/tmp/kubeconfig-mine', 'shop-abc123@/tmp/kubeconfig-system']);
      expect(revoked).toEqual(['build-1a2b', 'build-3c4d']);
      expect(await db.platform.hasMigration(BUILD_TOKENS_MIGRATION)).toBe(true);
      expect(await runOnce(db.platform, BUILD_TOKENS_MIGRATION, 'later', () => cleanUpBuildTokens(deps))).toEqual({});
      expect(revoked).toHaveLength(2);
    });

    it('wait for the next start, revoking nothing, while a build runs or an app\'s pull secret could not be rewritten', async () => {
      const busy = world({ runningBuilds: async () => 1 });
      await expect(cleanUpBuildTokens(busy.deps)).rejects.toThrow(new BuildTokensWait('1 build is running and may hold one'));
      expect([busy.written, busy.revoked]).toEqual([[], []]);

      const unreachable = world({ kubeconfigOf: async (entry) => { if (entry.id === 'mine') throw new Error('unreachable'); return '/tmp/k'; } });
      await expect(runOnce(db.platform, BUILD_TOKENS_MIGRATION, 'now', () => cleanUpBuildTokens(unreachable.deps))).rejects.toThrow('the pull secret of api (unreachable) could not be rewritten, and it may use one');
      expect(unreachable.revoked).toEqual([]);
      expect(await db.platform.hasMigration(BUILD_TOKENS_MIGRATION)).toBe(false);
    });

    it('wait, revoking nothing, for an app whose cluster Koala cannot find, rather than leave it pulling with a revoked token', async () => {
      await db.infrastructure.deleteCluster('mine');
      const orphaned = world();
      await expect(cleanUpBuildTokens(orphaned.deps)).rejects.toThrow('the pull secret of api (Koala knows no cluster mine) could not be rewritten, and it may use one');
      expect(orphaned.revoked).toEqual([]);
    });
  });
}
