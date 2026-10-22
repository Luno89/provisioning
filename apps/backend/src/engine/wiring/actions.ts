import type { Database } from '../../platform/index.js';
import { ActionService } from '../services/ActionService.js';
import {
  EgressService, EgressProxyService, AccessService, type TemporalBridge, type InfrastructureService,
  type InfisicalService, egressRouter, clusterAccessRouter,
} from '../../infrastructure/index.js';
import { SecretRequestService, secretRequestsRouter } from '../../projects/index.js';
import type { MonitoringService } from '../../monitoring/services/MonitoringService.js';
import type { TreeModelsService } from '../../models/services/TreeModelsService.js';
import type { McpServerService } from '../services/McpServerService.js';
import type { WorkspaceDependencyService } from '../services/WorkspaceDependencyService.js';
import type { AgentService } from '../services/AgentService.js';
import type { directoryFromDatabase } from '../../engine-host/index.js';
import { actionsRouter } from '../routes/actions.js';
import type { wireReleases } from '../../releases/index.js';
import type { Mounts } from '../../hub/wiring/hub.js';

export interface ActionsWiringDeps {
  tenant: Mounts;
  db: Database;
  env: NodeJS.ProcessEnv;
  egressKey: string;
  kubeconfig: string;
  temporalBridge: TemporalBridge;
  monitoring: Pick<MonitoringService, 'addRule' | 'removeRule'>;
  releaseSettings: ReturnType<typeof wireReleases>['releaseSettings'];
  treeModels: TreeModelsService;
  mcpCatalogue: Pick<McpServerService, 'add'>;
  workspaceDependencies: WorkspaceDependencyService;
  agentDirectory: Pick<ReturnType<typeof directoryFromDatabase>, 'agents'>;
  agentsHolder: { service?: AgentService };
  concluded: (ownerId: string, conversationId: string | undefined) => void;
  infra: InfrastructureService;
  infisical: InfisicalService;
}

export function wireActions(deps: ActionsWiringDeps): void {
  const { tenant, db, env, agentsHolder } = deps;
  tenant.use('/api/secret-requests', secretRequestsRouter({ secrets: new SecretRequestService({ store: db.projects, vault: deps.infisical }) }));
  tenant.use('/api/actions', actionsRouter({ actions: new ActionService({
    store: db,
    deployer: deps.temporalBridge,
    releases: deps.releaseSettings,
    treeModels: deps.treeModels,
    alerts: {
      add: (ownerId, deploymentId, spec, conversationId) => deps.monitoring.addRule({ id: ownerId }, deploymentId, spec, conversationId),
      remove: (ownerId, ruleId) => deps.monitoring.removeRule({ id: ownerId }, ruleId),
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
    proxy: new EgressProxyService({ kube: deps.infra, secret: deps.egressKey, kubeconfig: deps.kubeconfig }),
  });
  tenant.use('/api/egress', egressRouter({ egress: egressService }));
  tenant.use('/api/cluster-access', clusterAccessRouter({ access: new AccessService({ store: db }) }));
  if (env.NODE_ENV !== 'test') {
    egressService.syncProxy().catch((err: Error) => console.warn(`[egress] could not sync the proxy's grants: ${err.message}`));
  }
}
