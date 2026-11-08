import { createModelService } from '../../apps/backend/src/models/wiring/model-wiring.js';
import { devKoalasCluster, devGiteaUrl, devRegistry } from './dev-stack.js';
import { createEngineHost, storesFromDatabase } from '../../apps/backend/src/engine-host/host.js';
import { GiteaService } from '../../apps/backend/src/projects/services/GiteaService.js';
import type { Database } from '../../apps/backend/src/platform/lib/db-interface.js';
import { extensionServiceFor } from '../../apps/backend/src/engine/services/ExtensionService.js';
import { loadKeys } from '../../apps/backend/src/platform/lib/keys.js';
import { clusterSettingsFrom } from '../../apps/backend/src/platform/lib/settings.js';
import { InfrastructureService, terraformPlacesFor } from '../../apps/backend/src/infrastructure/services/InfrastructureService.js';
import { ProjectRepoService } from '../../apps/backend/src/projects/services/ProjectRepoService.js';
import { createWorkspaceRepoResolver } from '../../apps/backend/src/engine-host/sandboxes/workspace-repos.js';

export function liveEngineHost(db: Database) {
  const keys = loadKeys(process.env);
  const extensions = extensionServiceFor(db);
  const gitea = new GiteaService(keys.data, { url: devGiteaUrl });
  const projectRepos = new ProjectRepoService(db, gitea, keys.data);
  return createEngineHost({
    documents: { push: (request) => projectRepos.pushDocuments(request), pull: (request) => projectRepos.pullDocuments(request), merge: (request) => projectRepos.mergeDocuments(request) },
    repoFor: createWorkspaceRepoResolver({ trees: () => db.projects.getTrees(), projects: () => db.projects.getProjects(), accountOf: async (ownerId) => (await db.projects.getGiteaAccount(ownerId))?.username }),
    models: createModelService({ db, dataKey: keys.data, ...clusterSettingsFrom(process.env), infra: new InfrastructureService(terraformPlacesFor({ off: 'the live engine host runs no Terraform' })), mesh: { off: 'the live engine host reaches no mesh' }, endpointRules: { lab: false } }),
    stores: storesFromDatabase(db),
    cluster: devKoalasCluster(),
    registry: devRegistry(),
    registryAccount: async () => ({ owner: gitea.adminUsername, ...(await gitea.getAdminCredentials()) }),
    registryPushToken: async () => ({ username: gitea.adminUsername, password: (await gitea.createDeployToken()).token }),
    hidden: (ownerId: string) => extensions.hidden(ownerId),
    published: (ownerId: string) => extensions.groups(ownerId),
  });
}
