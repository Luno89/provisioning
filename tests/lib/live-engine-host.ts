import { createModelService } from '../../apps/backend/src/lib/model-wiring.js';
import { createEngineHost, storesFromDatabase } from '../../apps/backend/src/engine-host/host.js';
import { GiteaService } from '../../apps/backend/src/services/GiteaService.js';
import { InfrastructureService } from '../../apps/backend/src/services/InfrastructureService.js';
import type { Database } from '../../apps/backend/src/lib/db-interface.js';
import { extensionServiceFor } from '../../apps/backend/src/services/ExtensionService.js';
import { loadKeys } from '../../apps/backend/src/lib/keys.js';

export function liveEngineHost(db: Database) {
  const keys = loadKeys(process.env);
  const extensions = extensionServiceFor(db);
  const gitea = new GiteaService(new InfrastructureService(), keys.data, '/tmp/kubeconfig-provisioning-lunorica');
  return createEngineHost({
    models: createModelService(db, keys.data),
    stores: storesFromDatabase(db),
    kubeconfig: process.env.KUBECONFIG_PATH,
    registryHost: process.env.KOALA_REGISTRY,
    registryAccount: async () => ({ owner: gitea.adminUsername, ...(await gitea.getAdminCredentials()) }),
    registryPushToken: async () => ({ username: gitea.adminUsername, password: (await gitea.createDeployToken()).token }),
    hidden: (ownerId: string) => extensions.hidden(ownerId),
    published: (ownerId: string) => extensions.groups(ownerId),
  });
}
