import type { ClusterMetadata, DeploymentMetadata } from '../../platform/index.js';
import { namespaceOf } from '../lib/app-namespace.js';

export const BUILD_TOKENS_MIGRATION = 'build-tokens-revoked';

export interface BuildTokenCleanupDeps {
  deployments(): Promise<DeploymentMetadata[]>;
  clusters(): Promise<ClusterMetadata[]>;
  kubeconfigOf(cluster: ClusterMetadata): Promise<string>;
  writePullSecret(namespace: string, kubeconfig: string): Promise<void>;
  runningBuilds(): Promise<number>;
  buildTokens(): Promise<string[]>;
  revoke(name: string): Promise<void>;
}

export class BuildTokensWait extends Error {}

export async function cleanUpBuildTokens(deps: BuildTokenCleanupDeps): Promise<Record<string, number>> {
  const running = await deps.runningBuilds();
  if (running > 0) throw new BuildTokensWait(`${running} build${running === 1 ? ' is' : 's are'} running and may hold one`);

  const clusters = await deps.clusters();
  const apps = (await deps.deployments()).filter((deployment) => deployment.appType === 'gitapp' && deployment.status !== 'destroying');
  const unreachable: string[] = [];
  let rewritten = 0;
  for (const app of apps) {
    const cluster = clusters.find((entry) => entry.id === app.clusterId);
    if (!cluster) continue;
    try {
      await deps.writePullSecret(namespaceOf(app), await deps.kubeconfigOf(cluster));
      rewritten += 1;
    } catch (err) {
      unreachable.push(`${app.name} (${(err as Error).message})`);
    }
  }
  if (unreachable.length > 0) throw new BuildTokensWait(`the pull secret of ${unreachable.join(', ')} could not be rewritten, and it may use one`);

  const tokens = await deps.buildTokens();
  for (const name of tokens) await deps.revoke(name);
  return { pullSecretsRewritten: rewritten, buildTokensRevoked: tokens.length };
}
