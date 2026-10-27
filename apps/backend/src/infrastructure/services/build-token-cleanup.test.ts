import { describe, expect, it } from 'vitest';
import type { ClusterMetadata, DeploymentMetadata } from '../../platform/index.js';
import { memoryLedger, runOnce } from '../../platform/lib/migrations.js';
import { BUILD_TOKENS_MIGRATION, BuildTokensWait, cleanUpBuildTokens, type BuildTokenCleanupDeps } from './build-token-cleanup.js';

const cluster = (id: string) => ({ id, name: id, provider: 'k3d' }) as ClusterMetadata;
const app = (name: string, appType: string, clusterId = 'system', extra: Partial<DeploymentMetadata> = {}) =>
  ({ id: name, name, appType, clusterId, status: 'running', namespace: `${name}-abc123`, ...extra }) as DeploymentMetadata;

function world(over: Partial<BuildTokenCleanupDeps> = {}) {
  const written: string[] = [];
  const revoked: string[] = [];
  const deps: BuildTokenCleanupDeps = {
    deployments: async () => [app('shop', 'gitapp'), app('books', 'audiobookshelf'), app('api', 'gitapp', 'mine'), app('old', 'gitapp', 'system', { status: 'destroying' })],
    clusterOf: async (id) => [cluster('system'), cluster('mine')].find((entry) => entry.id === id),
    kubeconfigOf: async (entry) => `/tmp/kubeconfig-${entry.id}`,
    writePullSecret: async (namespace, kubeconfig) => { written.push(`${namespace}@${kubeconfig}`); },
    runningBuilds: async () => 0,
    buildTokens: async () => ['build-1a2b', 'build-3c4d'],
    revoke: async (name) => { revoked.push(name); },
    ...over,
  };
  return { deps, written, revoked };
}

describe('the build tokens Koala never revoked', () => {
  it('move every git-built app onto the read-only pull login first, then are all revoked, once', async () => {
    const { deps, written, revoked } = world();
    const ledger = memoryLedger();
    expect(await runOnce(ledger, BUILD_TOKENS_MIGRATION, 'now', () => cleanUpBuildTokens(deps))).toEqual({ pullSecretsRewritten: 2, buildTokensRevoked: 2 });
    expect(written).toEqual(['shop-abc123@/tmp/kubeconfig-system', 'api-abc123@/tmp/kubeconfig-mine']);
    expect(revoked).toEqual(['build-1a2b', 'build-3c4d']);
    expect(await runOnce(ledger, BUILD_TOKENS_MIGRATION, 'later', () => cleanUpBuildTokens(deps))).toEqual({});
    expect(revoked).toHaveLength(2);
  });

  it('wait for the next start, revoking nothing, while a build runs or an app\'s pull secret could not be rewritten', async () => {
    const busy = world({ runningBuilds: async () => 1 });
    await expect(cleanUpBuildTokens(busy.deps)).rejects.toThrow(new BuildTokensWait('1 build is running and may hold one'));
    expect([busy.written, busy.revoked]).toEqual([[], []]);

    const unreachable = world({ kubeconfigOf: async (entry) => { if (entry.id === 'mine') throw new Error('unreachable'); return '/tmp/k'; } });
    const ledger = memoryLedger();
    await expect(runOnce(ledger, BUILD_TOKENS_MIGRATION, 'now', () => cleanUpBuildTokens(unreachable.deps))).rejects.toThrow('the pull secret of api (unreachable) could not be rewritten, and it may use one');
    expect(unreachable.revoked).toEqual([]);
    expect(ledger.records).toEqual([]);

  });

  it('wait, revoking nothing, for an app whose cluster Koala cannot find, rather than leave it pulling with a revoked token', async () => {
    const orphaned = world({ clusterOf: async (id) => (id === 'system' ? cluster('system') : undefined) });
    await expect(cleanUpBuildTokens(orphaned.deps)).rejects.toThrow('the pull secret of api (Koala knows no cluster mine) could not be rewritten, and it may use one');
    expect(orphaned.revoked).toEqual([]);
  });
});
