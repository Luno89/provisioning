import { claimSettingsFrom, principalOf, servesTenants, type Database, type Principal, type RoleConfig } from '../../platform/index.js';
import { ActionService } from '../services/ActionService.js';
import {
  EgressService, EgressProxyService, AccessService, type TemporalBridge, type ClusterAccess,
  type InfisicalService, egressRouter, clusterAccessRouter,
} from '../../infrastructure/index.js';
import { SecretRequestService, secretRequestsRouter } from '../../projects/index.js';
import type { MonitoringService } from '../../monitoring/index.js';
import type { TreeModelsService } from '../../models/index.js';
import type { McpServerService } from '../services/McpServerService.js';
import type { WorkspaceDependencyService } from '../services/WorkspaceDependencyService.js';
import type { AgentService } from '../services/AgentService.js';
import type { directoryFromDatabase } from '../../engine-host/index.js';
import { actionsRouter } from '../routes/actions.js';
import type { wireReleases } from '../../releases/index.js';
import type { Mounts } from '../../platform/index.js';

export interface ActionsWiringDeps {
  tenant: Mounts;
  db: Database;
  role: RoleConfig;
  underTest: boolean;
  egressKey: string;
  temporalBridge: TemporalBridge;
  monitoring: Pick<MonitoringService, 'addRule' | 'removeRule'>;
  releaseSettings: ReturnType<typeof wireReleases>['releaseSettings'];
  treeModels: TreeModelsService;
  mcpCatalogue: Pick<McpServerService, 'add'>;
  workspaceDependencies: WorkspaceDependencyService;
  agentDirectory: Pick<ReturnType<typeof directoryFromDatabase>, 'agents'>;
  agentsHolder: { service?: AgentService };
  concluded: (ownerId: string, conversationId: string | undefined) => void;
  access: ClusterAccess;
  infisical: InfisicalService;
  clusters: { getById(id: string, principal: Principal, action: 'deploy-to'): Promise<unknown> };
}

export function wireActions(deps: ActionsWiringDeps): { egress: EgressService } {
  const { tenant, db, role, agentsHolder } = deps;
  const viewerOf = async (ownerId: string) => principalOf((await db.accounts.getUserById(ownerId)) ?? { id: ownerId }, claimSettingsFrom(role));
  tenant.use('/api/secret-requests', secretRequestsRouter({ secrets: new SecretRequestService({ store: db.projects, vault: deps.infisical }) }));
  tenant.use('/api/actions', actionsRouter({ actions: new ActionService({
    store: db,
    deployer: deps.temporalBridge,
    clusters: deps.clusters,
    releases: deps.releaseSettings,
    treeModels: deps.treeModels,
    alerts: {
      add: async (ownerId, deploymentId, spec, conversationId) => deps.monitoring.addRule(await viewerOf(ownerId), deploymentId, spec, conversationId),
      remove: async (ownerId, ruleId) => deps.monitoring.removeRule(await viewerOf(ownerId), ruleId),
    },
    servers: { add: (ownerId, input) => deps.mcpCatalogue.add(ownerId, input), list: (ownerId) => db.engine.getMcpServers(ownerId) },
    dependencies: deps.workspaceDependencies,
    agents: {
      agents: (ownerId) => deps.agentDirectory.agents(ownerId),
      holdServer: async (ownerId, slug, server, meta) => {
        if (!agentsHolder.service) throw new Error('agents cannot be changed yet');
        return agentsHolder.service.holdServer(ownerId, slug, server, meta);
      },
      image: async (ownerId, slug) => agentsHolder.service?.image(ownerId, slug),
    },
    onSettled: deps.concluded,
  }) }));
  const egressService = new EgressService({
    store: db.infrastructure,
    proxy: new EgressProxyService({ kube: deps.access, secret: deps.egressKey }),
  });
  tenant.use('/api/egress', egressRouter({ egress: egressService }));
  tenant.use('/api/cluster-access', clusterAccessRouter({ access: new AccessService({ store: db }) }));
  if (!deps.underTest && servesTenants(role)) void egressService.keepSynced();
  return { egress: egressService };
}
