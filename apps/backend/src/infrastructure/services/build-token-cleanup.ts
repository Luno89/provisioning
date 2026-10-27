import type { ClusterMetadata, DeploymentMetadata } from '../../platform/index.js';
import { namespaceOf } from '../lib/app-namespace.js';

export const BUILD_TOKENS_MIGRATION = 'build-tokens-revoked';

export interface BuildTokenCleanupDeps {
  deployments(): Promise<DeploymentMetadata[]>;
  clusterOf(id: string): Promise<ClusterMetadata | undefined>;
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

  const apps = (await deps.deployments()).filter((deployment) => deployment.appType === 'gitapp' && deployment.status !== 'destroying');
  const unreachable: string[] = [];
  for (const app of apps) {
    try {
      const cluster = await deps.clusterOf(app.clusterId);
      if (!cluster) throw new Error(`Koala knows no cluster ${app.clusterId}`);
      await deps.writePullSecret(namespaceOf(app), await deps.kubeconfigOf(cluster));
    } catch (err) {
      unreachable.push(`${app.name} (${(err as Error).message})`);
    }
  }
  if (unreachable.length > 0) throw new BuildTokensWait(`the pull secret of ${unreachable.join(', ')} could not be rewritten, and it may use one`);

  const tokens = await deps.buildTokens();
  for (const name of tokens) await deps.revoke(name);
  return { pullSecretsRewritten: apps.length, buildTokensRevoked: tokens.length };
}
