import { ignore } from '@koala/engine-core/failures';
import { ApplicationFailure } from '@temporalio/common';
import type { InfisicalService } from '../../infrastructure/index.js';
import { syncProjectSecrets } from '../../projects/index.js';
import { createDatabase } from '../../platform/lib/db-interface.js';
import { loadKeys } from '../../platform/lib/keys.js';
import type { VaultSync } from './slot-cluster.js';

export const syncVaultFromProject = (vault: InfisicalService): VaultSync => async (args) => {
  const db = createDatabase();
  await db.init();
  try {
    const project = (await db.projects.getProjects()).find((entry) => entry.id === args.projectId);
    if (!project) throw ApplicationFailure.nonRetryable(`the project ${args.projectId} is gone, so its vault cannot be synced`);
    const masterKey = loadKeys(process.env).data;
    await syncProjectSecrets({ infra: args.cluster, vault, projects: db.projects, masterKey }, { project, namespace: args.namespace, kubeconfig: args.kubeconfig, reach: args.reach, secretName: args.secretName });
  } finally {
    await db.close().catch(ignore('the connection is closed only to free it; the vault was synced, or why not is thrown'));
  }
};
