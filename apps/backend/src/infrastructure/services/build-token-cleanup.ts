import type { DeploymentMetadata } from '../../platform/index.js';
import { namespaceOf } from '../lib/app-namespace.js';
import { gitappPullSecretArgs, type PullLogin } from '../lib/gitapp-pull.js';
import type { ClusterAccess } from './ClusterAccess.js';

export const BUILD_TOKENS_MIGRATION = 'build-tokens-revoked';

export interface BuildTokenCleanupDeps {
  deployments(): Promise<DeploymentMetadata[]>;
  writePullSecret(clusterId: string, namespace: string): Promise<void>;
  runningBuilds(): Promise<number>;
  buildTokens(): Promise<string[]>;
  revoke(name: string): Promise<void>;
}

export interface PullRegistry {
  host(): Promise<string>;
  login(): Promise<PullLogin>;
}

export const pullSecretWriter = (access: Pick<ClusterAccess, 'kubectl' | 'apply'>, registry: PullRegistry) => async (clusterId: string, namespace: string): Promise<void> => {
  const secret = await access.kubectl(clusterId, gitappPullSecretArgs(namespace, await registry.host(), await registry.login()));
  await access.apply(clusterId, secret);
};

export class BuildTokensWait extends Error {}

export async function cleanUpBuildTokens(deps: BuildTokenCleanupDeps): Promise<Record<string, number>> {
  const running = await deps.runningBuilds();
  if (running > 0) throw new BuildTokensWait(`${running} build${running === 1 ? ' is' : 's are'} running and may hold one`);

  const apps = (await deps.deployments()).filter((deployment) => deployment.appType === 'gitapp' && deployment.status !== 'destroying');
  const unreachable: string[] = [];
  for (const app of apps) {
    try {
      await deps.writePullSecret(app.clusterId, namespaceOf(app));
    } catch (err) {
      unreachable.push(`${app.name} (${(err as Error).message})`);
    }
  }
  if (unreachable.length > 0) throw new BuildTokensWait(`the pull secret of ${unreachable.join(', ')} could not be rewritten, and it may use one`);

  const tokens = await deps.buildTokens();
  for (const name of tokens) await deps.revoke(name);
  return { pullSecretsRewritten: apps.length, buildTokensRevoked: tokens.length };
}
