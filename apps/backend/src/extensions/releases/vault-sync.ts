import { ApplicationFailure } from '@temporalio/common';
import type { InfrastructureService } from '../../infrastructure/services/InfrastructureService.js';
import { InfisicalService } from '../../infrastructure/services/InfisicalService.js';
import { sharedClusterProxy } from '../../infrastructure/services/ClusterProxyService.js';
import { syncProjectSecrets } from '../../projects/services/ProjectSecretSync.js';
import { createDatabase } from '../../platform/lib/db-interface.js';
import { loadKeys } from '../../platform/lib/keys.js';
import type { VaultSync } from './slot-cluster.js';

export const syncVaultFromProject = (infra: InfrastructureService): VaultSync => async (args) => {
  const db = createDatabase();
  await db.init();
  try {
    const project = (await db.getProjects()).find((entry) => entry.id === args.projectId);
    if (!project) throw ApplicationFailure.nonRetryable(`the project ${args.projectId} is gone, so its vault cannot be synced`);
    const masterKey = loadKeys(process.env).data;
    const vault = new InfisicalService(infra, masterKey, '/tmp/kubeconfig-provisioning-lunorica', undefined, sharedClusterProxy());
    await syncProjectSecrets({ infra, vault, projects: db, masterKey }, { project, namespace: args.namespace, kubeconfig: args.kubeconfig, target: args.target, secretName: args.secretName });
  } finally {
    await db.close().catch(() => undefined);
  }
};
