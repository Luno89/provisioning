#!/usr/bin/env node
/* eslint-disable no-console */
import { stopIfRunning } from './lib/stop-workflow.js';
import { createWorkspaceRepoResolver } from './engine-host/sandboxes/workspace-repos.js';
import dotenv from 'dotenv';
import { Worker, NativeConnection, Runtime } from '@temporalio/worker';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { createDatabase, sharedPayloadBlobs } from './lib/db-interface.js';
import { createPlanAdoption } from './engine-host/plan-adoption.js';
import { GiteaService } from './services/GiteaService.js';
import { InfrastructureService } from './services/InfrastructureService.js';
import { createModelService } from './lib/model-wiring.js';
import { createWorkerLogger } from './lib/worker-logger.js';
import { buildDataConverter } from './lib/temporal-codec.js';
import { InfisicalService } from './services/InfisicalService.js';
import { HeadscaleService } from './services/HeadscaleService.js';
import { createAccountRemovalActivities } from './activities/RemoveAccountActivities.js';
import { createProjectRemovalActivities } from './activities/RemoveProjectActivities.js';
import { createCheckProgressActivity, createCheckRunActivities } from './activities/CheckRunActivities.js';
import { withSeedBundle } from './engine-host/sandboxes/seed-bundle.js';
import { scriptedModelBase } from './lib/check-space.js';
import { labelValue } from './engine-host/sandboxes/workspace.js';
import { giteaUsernameFor } from './lib/projects.js';
import { wasReported } from './eval/level2/reported.js';
import { createProcedureExecutor } from './engine-host/nodes/index.js';
import { signJWT } from './lib/auth.js';
import axios from 'axios';
import { httpCheckAccess } from './services/CheckToolAccess.js';
import { ClusterProxyService } from './services/ClusterProxyService.js';
import { ProjectRepoService } from './services/ProjectRepoService.js';
import { createSecretVault } from './services/SecretRequestService.js';
import { McpRegistryService } from './services/McpRegistryService.js';
import { resolveMcpProbeUrl } from './lib/mcp-probe-url.js';
import { ClusterService } from './services/ClusterService.js';
import { visibleAppSpecs } from './lib/app-spec.js';
import { treeTypeChoices, treeLanguageFrom } from './lib/tree-types.js';
import { resolveBindings } from './lib/binding-resolve.js';
import { runCancelledVia } from './engine-host/temporal/run-cancellation.js';
import { getTemporalClient, resolveOwnersWith } from './lib/temporal-client.js';
import { createKubeRunner } from './engine-host/sandboxes/kube.js';

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
import { extensionServiceFor } from './services/ExtensionService.js';
import { loadKeys } from './lib/keys.js';
import { healthPort, serveHealth } from './lib/worker-health.js';
import { withHints } from './lib/mcp-tool-hints.js';
import { startedFor } from './lib/workflow-owner.js';
import { createArtifactService } from './services/artifact-service-factory.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: resolve(__dirname, '../.env') });

const keys = loadKeys(process.env);

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
  resolveOwnersWith(async (owner) => (await db.getUserById(owner))?.space?.person ?? owner);

  const models = createModelService(db, keys.data);
  const web = await buildWebTools(db).catch(() => undefined);

  const gitea = new GiteaService(new InfrastructureService(), keys.data, '/tmp/kubeconfig-provisioning-lunorica');
  const infisical = new InfisicalService(
    new InfrastructureService(),
    keys.data,
    '/tmp/kubeconfig-provisioning-lunorica',
    undefined,
    new ClusterProxyService(),
  );
  const projectRepos = new ProjectRepoService(db, gitea, keys.data);
  const kubeInfra = new InfrastructureService();
  const clusterService = new ClusterService(db, kubeInfra, keys.data);
  const artifactStore = createArtifactService(db, kubeInfra, clusterService);
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
  const extensions = extensionServiceFor(db);
  const checksApi = process.env.CHECKS_API_URL || `http://localhost:${process.env.PORT || 3001}/api`;
  const checks = httpCheckAccess(async (ownerId) => {
    const person = await db.getUserById(ownerId);
    if (!person) throw new Error(`there is no account ${ownerId} to act for`);
    return axios.create({ baseURL: checksApi, proxy: false, headers: { Cookie: `session=${signJWT({ userId: person.id, email: person.email }, keys.session, 60 * 60)}` } });
  });
  const host = createEngineHost({
    treeLanguage: treeLanguageFrom(db),
    artifacts: { keep: (ownerId, runId, files) => artifactStore.artifacts.put(ownerId, runId, files) },
    checks,
    documents: { push: (request) => projectRepos.pushDocuments(request), pull: (request) => projectRepos.pullDocuments(request), merge: (request) => projectRepos.mergeDocuments(request) },
    repoFor: createWorkspaceRepoResolver({ trees: () => db.getTrees(), projects: () => db.getProjects(), accountOf: async (ownerId) => (await db.getGiteaAccount(ownerId))?.username }),
    hidden: (ownerId: string) => extensions.hidden(ownerId),
    published: (ownerId: string) => extensions.groups(ownerId),
    models,
    stores: storesFromDatabase(db),
    vault,
    egressSecret: keys.egress,
    corpus: {
      crawlerReady: async (ownerId) => (await db.getDeployments()).some((dep) => dep.appType === 'crawl4ai' && dep.status === 'running' && dep.ownerId === ownerId),
      start: async (workflowId, args) => {
        await (await getTemporalClient()).workflow.start('executeIngestWorkflow', { taskQueue: 'host-ops-queue', workflowId, args: [args], ...startedFor(args.ownerId) });
      },
      status: async (workflowId) => {
        try {
          const handle = (await getTemporalClient()).workflow.getHandle(workflowId);
          const name = (await handle.describe()).status.name;
          if (name === 'RUNNING') return { state: 'running' };
          if (name === 'COMPLETED') return { state: 'completed', receipt: await handle.result() };
          const reason = await handle.result().then(() => name.toLowerCase(), (err: { cause?: { message?: string }; message?: string }) => err.cause?.message ?? err.message ?? name.toLowerCase());
          return { state: 'failed', error: reason };
        } catch (err) {
          return { state: 'unknown', error: (err as Error).message };
        }
      },
      pages: (filter) => db.getCorpusPages({ ownerId: filter.ownerId, ...(filter.ingestId ? { ingestId: filter.ingestId } : {}) }),
    },
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
        .map((spec) => ({ id: spec.id, builtIn: spec.builtIn, ...(spec.label ? { label: spec.label } : {}), ...(spec.uiDefaults?.strategies ? { strategies: spec.uiDefaults.strategies } : {}) })),
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
      servers: async (ownerId) => withHints(await registryFor(ownerId).listWithTools(), await db.getMcpToolHints(ownerId)),
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

  const engine = createEngineActivities({
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
    conversationWorkspaces: host.conversationWorkspaces,
    conversationAgent: async (ownerId, conversationId) => (await db.getConversation(ownerId, conversationId))?.agentSlug,
    allowedTools: async (ownerId, conversationId) => (await db.getConversation(ownerId, conversationId))?.allowedTools ?? [],
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
      // So a tree this adoption creates starts from its type's scaffold rather than an empty repo.
      treeTypes: (ownerId: string) => db.getTreeTypes(ownerId),
      registryHost: process.env.KOALA_REGISTRY,
    }),
    grove: {
      trees: { list: () => db.getTrees() },
      branches: { list: () => db.getBranches() },
      leaves: { list: () => db.getLeaves(), save: (leaf) => db.saveLeaf(leaf) },
      tasks: { list: () => db.getTasks() },
      // Where a run reads the stages its tree type names. Without this the worker sees no types at
      // all, and every stage quietly falls back to its default whatever the person chose.
      treeTypes: async (ownerId: string) => treeTypeChoices(await db.getTreeTypes(ownerId), ownerId),
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

  const temporal = await getTemporalClient();
  const removalWorkflows = {
    stopIfRunning: async (workflowId: string, reason: string) => (await stopIfRunning(temporal.workflow.getHandle(workflowId), reason)) !== 'not-running',
  };
  return {
    ...engine,
    ...createAccountRemovalActivities({
      store: db,
      workflows: removalWorkflows,
      kube: createKubeRunner(),
      repositories: gitea,
      mesh: new HeadscaleService(keys.data, process.env.HEADSCALE_URL || 'http://localhost:8080'),
      secrets: infisical,
    }),
    ...createProjectRemovalActivities({
      store: db,
      workflows: removalWorkflows,
      kube: createKubeRunner(),
      repositories: gitea,
      secrets: infisical,
    }),
    ...createCheckRunActivities({
      store: db as never,
      api: (space) => axios.create({
        baseURL: process.env.CHECKS_API_URL || `http://localhost:${process.env.PORT || 3001}/api`,
        proxy: false,
        headers: { Cookie: `session=${signJWT({ userId: space.id, email: space.email }, keys.session, 24 * 60 * 60)}` },
      }),
      seedFiles: (ownerId, repo, files) => withSeedBundle(files, async (bundle) => {
        await projectRepos.pushDocuments({ ownerId, repo, describe: 'A check\'s conversation workspace', bundle });
      }),
      scripted: { base: scriptedModelBase(process.env), dataKey: keys.data },
      terminate: async (runId, reason) => { await temporal.workflow.getHandle(runId).terminate(reason).catch(() => undefined); },
      leftovers: {
        records: (ownerId) => db.accountLeftovers(ownerId),
        workspaces: async (ownerId) => (await createKubeRunner()(['get', 'namespace', '-l', `koala.dev/owner=${labelValue(ownerId)}`, '-o', 'name'])).stdout.split('\n').map((line) => line.trim()).filter(Boolean),
        giteaUser: (ownerId) => gitea.userExists(giteaUsernameFor(ownerId)),
      },
      reported: (run, says, answer) => wasReported(createProcedureExecutor(host.services, { registry: host.registry }), { runId: run.runId, ownerId: run.spaceId, agent: run.agent, modelId: run.modelId }, says, answer),
    }),
    ...createCheckProgressActivity(db as never),
  };
}

async function main() {
  const queue = process.env.TEMPORAL_ENGINE_TASK_QUEUE || DEFAULT_ENGINE_TASK_QUEUE;
  const address = process.env.TEMPORAL_CONNECTION_ADDRESS || 'localhost:7233';
  logger.info(`[EngineWorker] Starting — taskQueue=${queue}, address=${address}`);

  const activities = await buildActivities();
  let current: Worker | undefined;
  const port = healthPort(process.env);
  if (port) serveHealth(port, () => current?.getState() === 'RUNNING');

  for (;;) {
    try {
      const connection = await NativeConnection.connect({ address });
      const dataConverter = buildDataConverter(keys.payload, sharedPayloadBlobs());

      const worker = await Worker.create({
        connection,
        ...(dataConverter ? { dataConverter } : {}),
        taskQueue: queue,
        workflowsPath: resolve(__dirname, 'workflows'),
        activities,
      });
      current = worker;

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
