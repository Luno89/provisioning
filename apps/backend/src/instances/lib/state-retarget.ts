import { appStackName } from '../../infrastructure/lib/deployment-id.js';
import { stateSecretName, stateSecretSuffix } from '../../infrastructure/lib/state-secret.js';
import type { KubeObject } from './app-move.js';

export interface StateRetarget {
  from: string;
  onto: string;
  deploymentIds: readonly string[];
}

export function retargetedStateSecrets(secrets: readonly KubeObject[], move: StateRetarget): KubeObject[] {
  const renamed = new Map(move.deploymentIds.map((id) => [stateSecretName(appStackName(move.from, id)), appStackName(move.onto, id)]));
  return secrets.map((secret) => {
    const stack = renamed.get(secret.metadata?.name ?? '');
    if (!stack) return secret;
    return { ...secret, metadata: { ...secret.metadata, name: stateSecretName(stack), labels: { ...secret.metadata?.labels, tfstateSecretSuffix: stateSecretSuffix(stack) } } };
  });
}
