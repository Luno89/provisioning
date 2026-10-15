#!/usr/bin/env node
/* eslint-disable no-console */
import { machineChoiceProblem } from './lib/machines.js';
import path from 'path';
import { DEFAULT_TARGET_CLUSTER } from './lib/project-shipping.js';
import { stopIfRunning } from './lib/stop-workflow.js';
import { createWorkspaceRepoResolver, treeOfWorkspace } from './engine-host/sandboxes/workspace-repos.js';
import { AutoModeService } from './services/AutoModeService.js';
import dotenv from 'dotenv';
import { Worker, NativeConnection, Runtime } from '@temporalio/worker';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { createDatabase, sharedPayloadBlobs } from './lib/db-interface.js';
import { createPlanAdoption } from './engine-host/plan-adoption.js';
import { GiteaService } from './services/GiteaService.js';
import { InfrastructureService, LOG_DIR } from './services/InfrastructureService.js';
import { createModelService } from './lib/model-wiring.js';
import { createWorkerLogger } from './lib/worker-logger.js';
import { buildDataConverter } from './lib/temporal-codec.js';
import { InfisicalService } from './services/InfisicalService.js';
import { HeadscaleService } from './services/HeadscaleService.js';
import { createAccountRemovalActivities } from './activities/RemoveAccountActivities.js';
import { createProjectRemovalActivities, type AppTeardown } from './activities/RemoveProjectActivities.js';
import { projectSecretsFor } from './services/ProjectSecretsService.js';
import { ProjectChannelService } from './services/ProjectChannelService.js';
import { createCheckReleases, createReleaseBrowserTestActivities, namespacedCluster } from './activities/ReleaseBrowserTestsActivity.js';
import { createSlotCluster } from './extensions/releases/slot-cluster.js';
import { deployProjectBuild } from './services/AppDeploy.js';
import { failureReason } from './lib/temporal-failure.js';
import { ODOO_RELEASE_ADAPTER } from './extensions/odoo/release-adapter.js';
import { syncVaultFromProject } from './extensions/releases/vault-sync.js';
import { Context as ActivityContext } from '@temporalio/activity';
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
import { sharedClusterProxy } from './services/ClusterProxyService.js';
import { ProjectRepoService } from './services/ProjectRepoService.js';
import { createSecretVault } from './services/SecretRequestService.js';
import { resolveMcpProbeUrl } from './lib/mcp-probe-url.js';
import { ClusterService } from './services/ClusterService.js';
import { visibleAppSpecs } from './lib/app-spec.js';
import { treeTypeChoices, treeLanguageFrom, treeExtrasFrom, dependencyNamespaceFrom, renderStarterFiles, groveAgentOf, resolveTreeType, versionVars } from './lib/tree-types.js';
import { TreeHomeService } from './services/TreeHomeService.js';
import { webhookAddress } from './services/webhook-address.js';
import { resolveBindings } from './lib/binding-resolve.js';
import { runCancelledVia, runEndedVia } from './engine-host/temporal/run-cancellation.js';
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
import { startedFor } from './lib/workflow-owner.js';
import { createGroveLauncher } from './engine-host/grove-launcher.js';
import { createRunStarter } from './engine-host/registries/run-starter.js';
import { WorkspaceBuildService } from './services/WorkspaceBuildService.js';
import { conversationBinding } from './engine-host/conversation-binding.js';
import type { GroveRunLauncher } from './services/GroveRunService.js';
import { createArtifactService } from './services/artifact-service-factory.js';
import { workflowOfRun } from './engine-host/temporal/contracts.js';
import { hostedMcpUrl } from './lib/mcp-hosted-url.js';
import { heartbeatWhileRunning } from '@koala/engine-core';

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
    sharedClusterProxy(),
  );
  const projectRepos = new ProjectRepoService(db, gitea, keys.data, webhookAddress(new InfrastructureService(), '/tmp/kubeconfig-provisioning-lunorica', process.env.PORT || 3001));
  const treeHome = new TreeHomeService({
    treeTypes: (ownerId) => db.getTreeTypes(ownerId),
    projects: () => db.getProjects(),
    createProject: (ownerId, project) => projectRepos.createProject(ownerId, project),
    starter: async (type, tree) => renderStarterFiles(type.files, { projectName: tree.name, registryHost: await gitea.getRegistryHost(), ...versionVars(type, tree) }),
    saveTree: (tree) => db.saveTree(tree),
    secrets: projectSecretsFor({ db, backend: infisical, readToken: async (ownerId) => (await projectRepos.mintReadToken(ownerId)).token }),
    saveNeeds: (project, needs) => db.saveProjectInfo({ id: project.id, needs }),
    channel: (project) => new ProjectChannelService({
      conversation: (ownerId, id) => db.getConversation(ownerId, id),
      save: (conversation) => db.saveConversation(conversation),
      bind: (ownerId, conversationId, binding) => db.bindConversation(ownerId, conversationId, binding),
      trees: () => db.getTrees(),
      saveProjectInfo: (entry) => db.saveProjectInfo(entry),
    }).ensure(project),
  });
  const kubeInfra = new InfrastructureService();
  const clusterService = new ClusterService(db, kubeInfra, keys.data);
  const artifactStore = createArtifactService(db, kubeInfra, clusterService);
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
  const engineStores = storesFromDatabase(db);
  const growers: { launcher?: GroveRunLauncher } = {};
  const groving = (): GroveRunLauncher => {
    if (!growers.launcher) throw new Error('the grove launcher is not ready yet');
    return growers.launcher;
  };
  const activityBeat = (detail?: unknown) => { try { ActivityContext.current().heartbeat(detail); } catch { return; } };
  const builders: { service?: WorkspaceBuildService } = {};
  const releaseBrowser = createReleaseBrowserTestActivities({
    cluster: namespacedCluster(kubeInfra),
    specs: async () => gitea,
    keep: (ownerId, runId, files) => artifactStore.artifacts.put(ownerId, runId, files),
  });
  const host = createEngineHost({
    releases: {
      cluster: createSlotCluster({ infra: kubeInfra, repo: async () => gitea, syncVault: syncVaultFromProject(kubeInfra), beat: activityBeat }),
      adapters: { [ODOO_RELEASE_ADAPTER.id]: ODOO_RELEASE_ADAPTER },
      releases: { list: (ownerId, projectId) => db.getOdooReleases(ownerId, projectId), save: (release) => db.saveOdooRelease(release) },
      browserTests: (request) => releaseBrowser.ReleaseBrowserTestsActivity(request),
      images: {
        deploy: async (projectId, pipelineRunId) => {
          const project = (await db.getProjects()).find((entry) => entry.id === projectId);
          const run = (await db.getPipelineRuns()).find((entry) => entry.id === pipelineRunId);
          if (!project || !run) throw new Error(project ? `the build ${pipelineRunId} is gone` : `the project ${projectId} is gone`);
          const client = await getTemporalClient();
          const started = await deployProjectBuild({
            db,
            client: () => client,
            masterKey: keys.data,
            clusterById: async (id) => (id === DEFAULT_TARGET_CLUSTER ? clusterService.getSystemClusterEntry() : (await db.getClusters()).find((cluster) => cluster.id === id)),
            logDir: LOG_DIR,
          }, project, run);
          return { workflowId: started.workflowId };
        },
        settled: async (workflowId) => {
          const handle = (await getTemporalClient()).workflow.getHandle(workflowId);
          for (;;) {
            activityBeat();
            const status = (await handle.describe()).status.name;
            if (status !== 'RUNNING') {
              const verdict = await handle.result().then((value) => value as { workload?: string; workloadReason?: string }, (err: unknown) => ({ failed: failureReason(status, err) }));
              if ('failed' in verdict) return { ok: false, reason: verdict.failed };
              return verdict.workload === 'unhealthy' ? { ok: false, reason: verdict.workloadReason || 'the app never became healthy' } : { ok: true };
            }
            await new Promise((done) => setTimeout(done, 5_000));
          }
        },
      },
    },
    publishedWorkspaces: { get: (ownerId: string, treeId: string) => db.getPublishedWorkspace(ownerId, treeId), save: (workspace) => db.savePublishedWorkspace(workspace) },
    readRepoFile: async (ownerId: string, repo: string, path: string, ref: string) => (await projectRepos.readDocument(ownerId, repo, path, ref))?.content,
    writeRepoFile: (ownerId, repo, path, content, message, branch) => projectRepos.putDocument(ownerId, repo, path, content, message, branch),
    workspaceBuild: async (ownerId, treeId, commit) => {
      if (!builders.service) throw new Error('the workspace builder is not ready yet');
      return builders.service.start(ownerId, treeId, commit);
    },
    treeLanguage: treeLanguageFrom(db),
    treeExtras: treeExtrasFrom(db, dependencyNamespaceFrom(db)),
    artifacts: { keep: (ownerId, runId, files) => artifactStore.artifacts.put(ownerId, runId, files) },
    checks,
    documents: { push: (request) => projectRepos.pushDocuments(request), pull: (request) => projectRepos.pullDocuments(request), merge: (request) => projectRepos.mergeDocuments(request) },
    repoFor: createWorkspaceRepoResolver({ trees: () => db.getTrees(), projects: () => db.getProjects(), accountOf: async (ownerId) => (await db.getGiteaAccount(ownerId))?.username }),
    hidden: (ownerId: string) => extensions.hidden(ownerId),
    published: (ownerId: string) => extensions.groups(ownerId),
    models,
    stores: { ...engineStores, grove: { ...engineStores.grove, growing: { start: (ownerId, treeId) => groving().startGroveRun(ownerId, treeId), status: (treeId) => groving().groveRunStatus(treeId) } } },
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
      releases: (ownerId, projectId) => db.getOdooReleases(ownerId, projectId),
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
    mcpServers: {
      list: (ownerId) => db.getMcpServers(ownerId),
      get: async (ownerId, id) => (await db.getMcpServers(ownerId)).find((server) => server.id === id),
      save: (server) => db.saveMcpServer(server),
      hostedUrl: hostedMcpUrl({ deployments: () => db.getDeployments(), probeUrl: resolveMcpProbeUrl }),
    },
    ...(web ? { web } : {}),
    kubeconfig: process.env.KUBECONFIG_PATH,
    registryHost: process.env.KOALA_REGISTRY,
    registryAccount: async () => ({ owner: gitea.adminUsername, ...(await gitea.getAdminCredentials()) }),
    registryPushToken: async () => ({ username: gitea.adminUsername, password: (await gitea.createDeployToken()).token }),
    onLeak: (runId, ageMs) => {
      logger.warn(`[engine] sandbox for ${runId} was still up ${Math.round(ageMs / 60_000)}m after it started, though its run has ended — tearing it down`);
    },
    runEnded: runEndedVia(() => getTemporalClient()),
  });
  const { registry, endpoints, environments, tools } = host;
  const autoMode = new AutoModeService({ store: db, agentExists: async (ownerId, slug) => Boolean(await registry.agent(ownerId, slug)) });
  const runStarter = createRunStarter({
    registry,
    workflows: () => ({
      start: async (type, options) => {
        const handle = await temporal.workflow.start(type, { workflowId: options.workflowId, taskQueue: options.taskQueue, args: options.args, memo: options.memo, ...startedFor(options.owner) });
        return { workflowId: handle.workflowId };
      },
      signal: async (workflowId, name, payload) => { await temporal.workflow.getHandle(workflowId).signal(name, ...(payload === undefined ? [] : [payload])); },
    }),
    binding: conversationBinding(db),
    closing: async (ownerId: string) => ((await db.getUserById(ownerId))?.removal ? 'it is being removed' : undefined),
    machines: async (ownerId, choice) => {
      const device = (await db.getLocalAgentDevices()).find((one) => one.id === choice.deviceId && one.ownerId === ownerId);
      return machineChoiceProblem(device ? { name: device.name, online: false, agents: device.agents ?? [] } : undefined, choice.agent, { waitsToConnect: true });
    },
  });
  builders.service = new WorkspaceBuildService({ runs: runStarter, trees: () => db.getTrees(), hidden: (ownerId: string) => extensions.hidden(ownerId) });
  growers.launcher = createGroveLauncher({
    hidden: (ownerId: string) => extensions.hidden(ownerId),
    runs: runStarter,
    client: () => temporal.workflow,
    agentFor: async (ownerId: string, treeId: string) => {
      const tree = (await db.getTrees()).find((entry) => entry.id === treeId && entry.ownerId === ownerId);
      return groveAgentOf(await resolveTreeType(db, ownerId, tree?.type));
    },
    leafRun: async (leafId: string) => (await db.getLeaves()).find((leaf) => leaf.id === leafId)?.runId,
  });

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
    autoMode: (args) => autoMode.unasked({ ...args, treeId: args.workspaceRunId ? treeOfWorkspace(args.workspaceRunId) : undefined }),
    plans: { list: (ownerId) => db.getPlanProposals(ownerId) },
    planAdoption: createPlanAdoption({
      stores: {
        proposals: { get: (ownerId, id) => db.getPlanProposal(ownerId, id), save: (proposal) => db.savePlanProposal(proposal) },
        trees: { list: () => db.getTrees(), save: (tree) => db.saveTree(tree) },
        branches: { list: () => db.getBranches(), save: (branch) => db.saveBranch(branch) },
        leaves: { list: () => db.getLeaves(), save: (leaf) => db.saveLeaf(leaf) },
        tasks: { list: (ownerId) => db.getTasks(ownerId), save: (task) => db.saveTask(task) },
        conversations: { bind: (ownerId, conversationId, binding) => db.bindConversation(ownerId, conversationId, binding) },
      },
      treeWorkspaces: host.treeWorkspaces,
      environments: host.environments,
      // So a tree this adoption creates starts from its type's scaffold rather than an empty repo.
      treeTypes: (ownerId: string) => db.getTreeTypes(ownerId),
      registryHost: process.env.KOALA_REGISTRY,
      homeTree: (tree) => treeHome.home(tree, { starter: false }),
      stopRun: async (workflowId: string) => { await stopIfRunning(temporal.workflow.getHandle(workflowId), 'the story it was working changed'); },
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
  const appTeardown: AppTeardown = {
    clusterById: async (id) => (id === DEFAULT_TARGET_CLUSTER ? clusterService.getSystemClusterEntry() : (await db.getClusters()).find((cluster) => cluster.id === id)),
    logFile: () => path.join(LOG_DIR, `${Date.now()}-${Math.random().toString(36).slice(2)}-D4.log`),
    taskQueue: 'cluster-ops-queue',
  };
  return {
    ...engine,
    ...createAccountRemovalActivities({
      store: db,
      apps: appTeardown,
      workflows: removalWorkflows,
      kube: createKubeRunner(),
      repositories: gitea,
      mesh: new HeadscaleService(keys.data, process.env.HEADSCALE_URL || 'http://localhost:8080'),
      secrets: infisical,
    }),
    ...createProjectRemovalActivities({
      store: db,
      apps: appTeardown,
      workflows: removalWorkflows,
      kube: createKubeRunner(),
      repositories: gitea,
      secrets: infisical,
      artifacts: artifactStore.artifacts,
    }),
    ReleaseBrowserTestsActivity: releaseBrowser.ReleaseBrowserTestsActivity,
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
      releases: createCheckReleases({
        browser: releaseBrowser,
        cluster: namespacedCluster(kubeInfra),
        project: async (id) => (await db.getProjects()).find((project) => project.id === id),
        clusterById: async (id) => (id === DEFAULT_TARGET_CLUSTER ? clusterService.getSystemClusterEntry() : (await db.getClusters()).find((cluster) => cluster.id === id)),
      }),
      terminate: async (runId, reason) => { await temporal.workflow.getHandle(workflowOfRun(runId)).terminate(reason).catch(() => undefined); },
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
        interceptors: { activity: [heartbeatWhileRunning()] },
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
