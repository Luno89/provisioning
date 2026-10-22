import fs from 'fs/promises';

import {
  InfrastructureService, hasCloudCredentials, isMockCloudProvider, isSelfManagedCluster, type DestroyAppArgs,
  namespaceOf,
} from '../infrastructure/index.js';
import { reachCluster } from './cluster-access.js';
import { ODOO_PROJECT_APP } from '../releases/index.js';

export type { DestroyAppArgs } from '../infrastructure/index.js';

export interface DestroyAppResult {
  status: string;
  msg: string;
}


export async function DestroyAppActivity(
  args: DestroyAppArgs,
): Promise<DestroyAppResult> {
  const infra = new InfrastructureService();
  const namespace = namespaceOf(args);

  const isMock = isMockCloudProvider(args.provider, hasCloudCredentials);
  const physicalName = isMock ? `mock-${args.provider}-${args.clusterName}` : args.clusterName;
  const kubeconfigPath = isSelfManagedCluster(args.provider, isMock)
    ? `/tmp/kubeconfig-${physicalName}`
    : undefined;

  const stackName = `app-${physicalName}-${args.deploymentId || 'default'}`;
  const logFile = args.logFile;

  if (args.appType === ODOO_PROJECT_APP) {
    const kubeconfig = await reachCluster(infra, { clusterName: args.clusterName, provider: args.provider, gpuEnabled: args.gpuEnabled, kubeconfigPath: args.kubeconfigPath });
    const release = namespace;
    await fs.appendFile(logFile, `Uninstalling the Odoo release ${release} and its namespace, databases and attachments with it\n`).catch(() => undefined);
    await infra.runHelm(['uninstall', release, '-n', release, '--ignore-not-found'], kubeconfig);
    await infra.runKubectl(['delete', 'namespace', release, '--ignore-not-found', '--wait=false'], kubeconfig);
    await infra.waitForNamespaceDeletion(release, kubeconfig);
    return { status: 'destroyed', msg: `App ${args.name} destroyed` };
  }

  await infra.destroy(stackName, {
    logFile,
    env: {
      STACK_TYPE: 'app',
      CLUSTER_NAME: physicalName,
      DEPLOYMENT_STRATEGY: args.strategy,
      DEPLOYMENT_NAME: namespace,
      DEPLOYMENT_ID: args.deploymentId || 'default',
      KUBECONFIG: kubeconfigPath || '',
      KUBECONFIG_CONTEXT: (args.provider === 'k3d' || isMock) ? `k3d-${physicalName}` : '',
      SELF_MANAGED_K8S: isSelfManagedCluster(args.provider, isMock) ? 'true' : 'false',
    },
  });

  await infra.waitForNamespaceDeletion(namespace, kubeconfigPath);

  return { status: 'destroyed', msg: `App ${args.name} destroyed` };
}
