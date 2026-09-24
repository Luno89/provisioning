import { createModelService } from '../../apps/backend/src/lib/model-wiring.js';
import { createEngineHost, storesFromDatabase } from '../../apps/backend/src/engine-host/host.js';
import { GiteaService } from '../../apps/backend/src/services/GiteaService.js';
import { InfrastructureService } from '../../apps/backend/src/services/InfrastructureService.js';
import type { Database } from '../../apps/backend/src/lib/db-interface.js';

export function liveEngineHost(db: Database) {
  const gitea = new GiteaService(new InfrastructureService(), process.env.JWT_SECRET || 'provisioning-platform-secret-12345', '/tmp/kubeconfig-provisioning-lunorica');
  return createEngineHost({
    models: createModelService(db, process.env.JWT_SECRET ?? ''),
    stores: storesFromDatabase(db),
    kubeconfig: process.env.KUBECONFIG_PATH,
    registryHost: process.env.KOALA_REGISTRY,
    registryAccount: async () => ({ owner: gitea.adminUsername, ...(await gitea.getAdminCredentials()) }),
    registryPushToken: async () => ({ username: gitea.adminUsername, password: (await gitea.createDeployToken()).token }),
  });
}
