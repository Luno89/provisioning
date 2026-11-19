import { stateSecretName, stateSecretSuffix } from 'cdktf-infra/state-name';
import { appStackName } from '../../infrastructure/lib/deployment-id.js';
import { monitoringStackName, type MonitoringStackPart } from '../../monitoring/lib/cluster-monitoring.js';
import type { KubeObject } from './app-move.js';

export interface StateRetarget {
  from: string;
  onto: string;
  deploymentIds: readonly string[];
}

export function retargetedStateSecrets(secrets: readonly KubeObject[], move: StateRetarget): KubeObject[] {
  const renamed = new Map(move.deploymentIds.map((id) => [stateSecretName(appStackName(move.from, id)), appStackName(move.onto, id)]));
  const unused = new Set((['cluster', 'observability'] as const satisfies readonly MonitoringStackPart[]).map((part) => stateSecretName(monitoringStackName(move.from, part))));
  return secrets.filter((secret) => !unused.has(secret.metadata?.name ?? '')).map((secret) => {
    const stack = renamed.get(secret.metadata?.name ?? '');
    if (!stack) return secret;
    return { ...secret, metadata: { ...secret.metadata, name: stateSecretName(stack), labels: { ...secret.metadata?.labels, tfstateSecretSuffix: stateSecretSuffix(stack) } } };
  });
}
