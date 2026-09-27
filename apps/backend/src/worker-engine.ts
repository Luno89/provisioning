#!/usr/bin/env node
/* eslint-disable no-console */
import dotenv from 'dotenv';
import { Worker, NativeConnection, Runtime } from '@temporalio/worker';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { createDatabase } from './lib/db-interface.js';
import { createPlanAdoption } from './engine-host/plan-adoption.js';
import { GiteaService } from './services/GiteaService.js';
import { InfrastructureService } from './services/InfrastructureService.js';
import { createModelService } from './lib/model-wiring.js';
import { createWorkerLogger } from './lib/worker-logger.js';
import { buildDataConverter } from './lib/temporal-codec.js';
import { InfisicalService } from './services/InfisicalService.js';
import { ClusterProxyService } from './services/ClusterProxyService.js';
import { ProjectRepoService } from './services/ProjectRepoService.js';
import { createSecretVault } from './services/SecretRequestService.js';
import { McpRegistryService } from './services/McpRegistryService.js';
import { resolveMcpProbeUrl } from './lib/mcp-probe-url.js';
import { ClusterService } from './services/ClusterService.js';
import { visibleAppSpecs } from './lib/app-spec.js';
import { resolveBindings } from './lib/binding-resolve.js';
import { runCancelledVia } from './engine-host/temporal/run-cancellation.js';
import { getTemporalClient } from './lib/temporal-client.js';

import { createEventBus } from '@koala/agent-engine';
import {
  createEngineActivities,
  createEffortTracker,
  createEngineHost,
  storesFromDatabase,
  DEFAULT_ENGINE_TASK_QUEUE,
  type Task,
  type MergeArgs,
  type RecordTracesArgs,
} from './engine-host/index.js';
import { createHostNodes, hostNodesFor } from './engine-host/nodes/index.js';
import { buildWebTools } from './lib/web-tools-wiring.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: resolve(__dirname, '../.env') });

const logger = createWorkerLogger('engine-worker');

Runtime.install({
  logger,
  telemetryOptions: {
    metrics: {
      prometheus: {
        bindAddress: `0.0.0.0:${process.env.TEMPORAL_ENGINE_METRICS_PORT || '9467'}`,
      },
    },
  },
});

async function buildActivities() {
  const db = createDatabase();
  await db.init();

  const models = createModelService(db, process.env.JWT_SECRET ?? '');
  const web = await buildWebTools(db).catch(() => undefined);

  const gitea = new GiteaService(new InfrastructureService(), process.env.JWT_SECRET || 'provisioning-platform-secret-12345', '/tmp/kubeconfig-provisioning-lunorica');
  const infisical = new InfisicalService(
    new InfrastructureService(),
    process.env.JWT_SECRET ?? '',
    '/tmp/kubeconfig-provisioning-lunorica',
    undefined,
    new ClusterProxyService(),
  );
  const projectRepos = new ProjectRepoService(db, gitea, process.env.JWT_SECRET ?? '');
  const kubeInfra = new InfrastructureService();
  const clusterService = new ClusterService(db, kubeInfra, process.env.JWT_SECRET ?? '');
  const mcpRegistries = new Map<string, McpRegistryService>();
  const registryFor = (ownerId: string): McpRegistryService => {
    const known = mcpRegistries.get(ownerId);
    if (known) return known;
    const made = new McpRegistryService(db, ownerId, (namespace: string) => resolveMcpProbeUrl(namespace));
    mcpRegistries.set(ownerId, made);
    return made;
  };
  const vault = createSecretVault({
    backend: infisical,
    minters: { readToken: async (ownerId) => (await projectRepos.mintReadToken(ownerId)).token },
  });
  const host = createEngineHost({
    models,
    stores: storesFromDatabase(db),
    vault,
    egressSecret: process.env.JWT_SECRET,
    projects: {
      projects: { list: () => db.getProjects() },
      trees: { list: () => db.getTrees() },
      binding: async (ownerId, conversationId) => {
        const conversation = await db.getConversation(ownerId, conversationId);
        return conversation ? { treeId: conversation.treeId, projectId: conversation.projectId } : undefined;
      },
      runs: () => db.getPipelineRuns(),
      deployments: () => db.getDeployments(),
      clusters: async (ownerId) => [
        await clusterService.getSystemClusterEntry(),
        ...(await db.getClusters()).filter((cluster) => cluster.ownerId === ownerId && !cluster.isSystem),
      ],
      appTypes: async (ownerId) => visibleAppSpecs(await db.getAppSpecs(), ownerId)
        .map((spec) => ({ id: spec.id, ...(spec.label ? { label: spec.label } : {}), ...(spec.uiDefaults?.strategies ? { strategies: spec.uiDefaults.strategies } : {}) })),
      readPath: (project, path) => projectRepos.readPath(project, path),
      bindingCheck: async (ownerId, service, as) => {
        const dynamicTypes = await db.getBindingTypes().catch(() => []);
        const { bindings, problems } = resolveBindings([{ service, ...(as ? { as } : {}) }], await db.getDeployments(), await db.getAppSpecs(), ownerId, { dynamicTypes });
        const binding = bindings[0];
        return binding ? { name: binding.name, type: binding.type } : { problem: problems[0] ?? `cannot bind to "${service}"` };
      },
      proposals: { list: (ownerId) => db.getActionProposals(ownerId), save: (proposal) => db.saveActionProposal(proposal) },
    },
    kube: {
      clusters: async (ownerId) => [
        await clusterService.getSystemClusterEntry(),
        ...(await db.getClusters()).filter((cluster) => cluster.ownerId === ownerId && !cluster.isSystem),
      ],
      deployments: () => db.getDeployments(),
      kubectl: async (cluster, argv) => String(await kubeInfra.runKubectl(argv, await clusterService.getKubeconfigPath(cluster))),
      isAdmin: async (ownerId) => (await db.getUserById(ownerId))?.isAdmin === true,
      openNamespaces: async (ownerId, conversationId) => (await db.getConversation(ownerId, conversationId))?.platformNamespaces ?? [],
      accessRequests: {
        list: (ownerId, conversationId) => db.getAccessRequests(ownerId, conversationId),
        save: (request) => db.saveAccessRequest(request),
      },
    },
    mcp: {
      servers: (ownerId) => registryFor(ownerId).listWithTools(),
      call: (ownerId, server, tool, args) => registryFor(ownerId).call(server, tool, args),
    },
    ...(web ? { web } : {}),
    kubeconfig: process.env.KUBECONFIG_PATH,
    registryHost: process.env.KOALA_REGISTRY,
    registryAccount: async () => ({ owner: gitea.adminUsername, ...(await gitea.getAdminCredentials()) }),
    registryPushToken: async () => ({ username: gitea.adminUsername, password: (await gitea.createDeployToken()).token }),
    onLeak: (runId, ageMs) => {
      logger.warn(`[engine] sandbox for ${runId} outlived its run by ${Math.round(ageMs / 60_000)}m — tearing it down`);
    },
  });
  const { registry, endpoints, environments, tools } = host;

  const sweeper = setInterval(() => {
    void host.runEnvironments.sweep();
  }, 10 * 60_000);
  sweeper.unref();

  const bus = createEventBus();
  bus.subscribe((event) => {
    if (event.type === 'thinking' || event.type === 'content') return;
    logger.info(`[engine] ${event.runId} ${event.type}`);
  });

  const hostNodes = hostNodesFor(createHostNodes(host.services), ['activity', 'sandbox']);

  return createEngineActivities({
    registry,
    endpoints,
    environments,
    tools,
    hostNodes,
    runCancelled: runCancelledVia(() => getTemporalClient()),
    tasks: {
      list: (ownerId: string) => db.getTasks(ownerId),
      save: (task: Task) => db.saveTask(task),
    },
    treeWorkspaces: host.treeWorkspaces,
    plans: { list: (ownerId) => db.getPlanProposals(ownerId) },
    planAdoption: createPlanAdoption({
      stores: {
        proposals: { get: (ownerId, id) => db.getPlanProposal(ownerId, id), save: (proposal) => db.savePlanProposal(proposal) },
        trees: { list: () => db.getTrees(), save: (tree) => db.saveTree(tree) },
        branches: { list: () => db.getBranches(), save: (branch) => db.saveBranch(branch) },
        leaves: { list: () => db.getLeaves(), save: (leaf) => db.saveLeaf(leaf) },
        tasks: { list: (ownerId) => db.getTasks(ownerId), save: (task) => db.saveTask(task) },
      },
      treeWorkspaces: host.treeWorkspaces,
      environments: host.environments,
    }),
    grove: {
      trees: { list: () => db.getTrees() },
      branches: { list: () => db.getBranches() },
      leaves: { list: () => db.getLeaves(), save: (leaf) => db.saveLeaf(leaf) },
      tasks: { list: () => db.getTasks() },
    },
    effort: createEffortTracker({
      models,
      registry,
      store: {
        save: (effort) => db.saveRunEffort(effort),
        list: (ownerId, procedureId, modelKey) => db.getRunEffort(ownerId, procedureId, modelKey),
      },
    }),
    traces: {
      record: ({ ownerId, runId, agentSlug, procedureId, procedureVersion, traces }: RecordTracesArgs) =>
        db.saveRunTraces(traces.map((trace) => ({ ...trace, ownerId, runId, agentSlug, procedureId, procedureVersion }))),
    },
    merges: {
      run: async ({ children }: MergeArgs) => ({
        children: children.map((child) => ({ agent: child.agentId, outcome: child.outcome, outputs: child.outputs })),
      }),
    },
    bus,
  });
}

async function main() {
  const queue = process.env.TEMPORAL_ENGINE_TASK_QUEUE || DEFAULT_ENGINE_TASK_QUEUE;
  const address = process.env.TEMPORAL_CONNECTION_ADDRESS || 'localhost:7233';
  logger.info(`[EngineWorker] Starting — taskQueue=${queue}, address=${address}`);

  const activities = await buildActivities();

  for (;;) {
    try {
      const connection = await NativeConnection.connect({ address });
      const dataConverter = buildDataConverter(process.env.JWT_SECRET);

      const worker = await Worker.create({
        connection,
        ...(dataConverter ? { dataConverter } : {}),
        taskQueue: queue,
        workflowsPath: resolve(__dirname, 'workflows'),
        activities,
      });

      logger.info('[EngineWorker] Connected, polling for work');
      await worker.run();
      return;
    } catch (err) {
      logger.error(`[EngineWorker] ${(err as Error).message} — retrying in 5s`);
      await new Promise((done) => setTimeout(done, 5_000));
    }
  }
}

main().catch((err) => {
  logger.error(`[EngineWorker] fatal: ${(err as Error).message}`);
  process.exit(1);
});
