#!/usr/bin/env node
import { machineChoiceProblem, accountDefaultOf } from './machines/index.js';
import {
  catalogueOf, AutoModeService, resolveMcpProbeUrl, extensionServiceFor, WorkspaceBuildService, hostedMcpUrl,
} from './engine/index.js';
import { startOnceQuiet } from './engine-host/grove-launcher.js';
import { SHIPPED_DEPENDENCIES } from './extensions/workspace-dependencies.js';
import path from 'path';
import {
  DEFAULT_TARGET_CLUSTER, GiteaService, projectSecretsFor, ProjectChannelService, ODOO_TREE_TYPE,
  treeTypeOfProject, giteaUsernameFor, ProjectRepoService, createSecretVault, treeTypeChoices, treeLanguageFrom,
  treeExtrasFrom, dependencyNamespaceFrom, renderStarterFiles, groveAgentOf, resolveTreeType, versionVars,
  TreeHomeService, webhookAddress, type GroveRunLauncher,
} from './projects/index.js';
import {
  stopIfRunning, createDatabase, sharedPayloadBlobs, createWorkerLogger, buildDataConverter, failureReason,
  signJWT, clusterOwnership, roleFromEnv, getTemporalClient, resolveOwnersWith, loadKeys, startedFor,
} from './platform/index.js';
import { createWorkspaceRepoResolver, treeOfWorkspace } from './engine-host/sandboxes/workspace-repos.js';
import dotenv from 'dotenv';
import { Worker, NativeConnection, Runtime } from '@temporalio/worker';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { createPlanAdoption } from './engine-host/plan-adoption.js';
import {
  InfrastructureService, LOG_DIR, InfisicalService, HeadscaleService, deployProjectBuild, sharedClusterProxy,
  ClusterService, visibleAppSpecs, resolveBindings, healthPort, serveHealth,
} from './infrastructure/index.js';
import { createModelService } from './models/wiring/model-wiring.js';
import { createAccountRemovalActivities } from './activities/RemoveAccountActivities.js';
import { createProjectRemovalActivities, type AppTeardown } from './activities/RemoveProjectActivities.js';
import { createCheckReleases, createReleaseBrowserTestActivities, namespacedCluster } from './activities/ReleaseBrowserTestsActivity.js';
import { createSlotCluster } from './extensions/releases/slot-cluster.js';
import { CustomizationsService } from './releases/services/CustomizationsService.js';
import { releaseHowOf, projectChoicesPatch, type ClientImport } from './releases/index.js';
import { ODOO_RELEASE_ADAPTER } from './extensions/odoo/release-adapter.js';
import { syncVaultFromProject } from './extensions/releases/vault-sync.js';
import { Context as ActivityContext } from '@temporalio/activity';
import { createCheckProgressActivity, createCheckRunActivities } from './activities/CheckRunActivities.js';
import { withSeedBundle } from './engine-host/sandboxes/seed-bundle.js';
import { scriptedModelBase } from './checks/lib/check-space.js';
import { labelValue } from './engine-host/sandboxes/workspace.js';
import { itSays, wasReported } from './eval/level2/reported.js';
import { createProcedureExecutor } from './engine-host/nodes/index.js';
import axios from 'axios';
import { httpCheckAccess } from './checks/services/CheckToolAccess.js';
import { MonitoringService, prometheusAt } from './monitoring/services/MonitoringService.js';
import { poolMonitor, poolMonitorFrom } from './monitoring/services/PoolMonitor.js';
import { runCancelledVia, runEndedVia } from './engine-host/temporal/run-cancellation.js';
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
import { buildWebTools } from './engine/wiring/web-tools.js';
import { createGroveLauncher } from './engine-host/grove-launcher.js';
import { createRunStarter } from './engine-host/registries/run-starter.js';
import { conversationBinding } from './engine-host/conversation-binding.js';
import { createArtifactService, FileServerUnreachableError, FileStores, FileService } from './files/index.js';
import { treeOfGroveRun, workflowOfRun } from './engine-host/temporal/contracts.js';
import { TreeModelsService, treeAgentsFrom } from './models/services/TreeModelsService.js';
import { platformGroups } from './extensions/installed.js';
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
  resolveOwnersWith(async (owner) => (await db.accounts.getUserById(owner))?.space?.person ?? owner);

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
    treeTypes: (ownerId) => db.projects.getTreeTypes(ownerId),
    projects: () => db.projects.getProjects(),
    createProject: (ownerId, project) => projectRepos.createProject(ownerId, project),
    starter: async (type, tree) => renderStarterFiles(type.files, { projectName: tree.name, registryHost: await gitea.getRegistryHost(), ...versionVars(type, tree) }),
    saveTree: (tree) => db.projects.saveTree(tree),
    secrets: projectSecretsFor({ db: db.projects, backend: infisical, readToken: async (ownerId) => (await projectRepos.mintReadToken(ownerId)).token }),
    saveNeeds: (project, needs) => db.projects.saveProjectInfo({ id: project.id, needs }),
    channel: (project) => new ProjectChannelService({
      conversation: (ownerId, id) => db.engine.getConversation(ownerId, id),
      save: (conversation) => db.engine.saveConversation(conversation),
      bind: (ownerId, conversationId, binding) => db.engine.bindConversation(ownerId, conversationId, binding),
      trees: () => db.projects.getTrees(),
      saveProjectInfo: (entry) => db.projects.saveProjectInfo(entry),
    }).ensure(project),
  });
  const kubeInfra = new InfrastructureService();
  const clusterService = new ClusterService(db, kubeInfra, keys.data);
  const artifactStore = createArtifactService(db, kubeInfra, clusterService);
  const fileStores = new FileStores(artifactStore.reach);
  const vault = createSecretVault({
    backend: infisical,
    minters: { readToken: async (ownerId) => (await projectRepos.mintReadToken(ownerId)).token },
  });
  const extensions = extensionServiceFor(db);
  const checksApi = process.env.CHECKS_API_URL || `http://localhost:${process.env.PORT || 3001}/api`;
  const checks = httpCheckAccess(async (ownerId) => {
    const person = await db.accounts.getUserById(ownerId);
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
    cluster: namespacedCluster(kubeInfra, () => gitea.registryLogin()),
    specs: async () => gitea,
    keep: (ownerId, runId, files) => artifactStore.artifacts.put(ownerId, runId, files),
  });
  const customizations = new CustomizationsService({
    projects: () => db.projects.getProjects(),
    clusterById: async (id) => (id === DEFAULT_TARGET_CLUSTER ? clusterService.getSystemClusterEntry() : (await db.infrastructure.getClusters()).find((cluster) => cluster.id === id)),
    how: async (project) => releaseHowOf(project, await treeTypeOfProject(db.projects, project), true),
    cluster: createSlotCluster({ infra: kubeInfra, repo: async () => gitea, registry: () => gitea.registryLogin(), syncVault: syncVaultFromProject(kubeInfra) }),
    adapters: { [ODOO_RELEASE_ADAPTER.id]: ODOO_RELEASE_ADAPTER },
    trees: () => db.projects.getTrees(),
    branches: () => db.projects.getBranches(),
    leaves: () => db.projects.getLeaves(),
    tasks: (ownerId) => db.projects.getTasks(ownerId),
    savePlan: (proposal) => db.projects.savePlanProposal(proposal),
    treeTypeOf: async (project) => (await treeTypeOfProject(db.projects, project))?.id ?? ODOO_TREE_TYPE,
  });
  const engineRole = roleFromEnv(process.env);
  const placeOnPool = poolMonitorFrom(process.env);
  const onPool = placeOnPool ? poolMonitor(placeOnPool) : undefined;
  const monitoring = new MonitoringService({
    store: db,
    systemCluster: () => clusterService.getSystemClusterEntry(),
    ownsCluster: clusterOwnership(engineRole.instance?.ownerId),
    pool: (cluster) => (cluster.isSystem ? onPool : undefined),
    prometheus: async (cluster) => prometheusAt(await sharedClusterProxy().serviceUrl(cluster.id, 'prometheus', await clusterService.getKubeconfigPath(cluster))),
    kubectl: async (cluster, args) => String(await kubeInfra.runKubectl(args, await clusterService.getKubeconfigPath(cluster))),
    apply: async (cluster, manifest) => { await kubeInfra.applyManifest(manifest, await clusterService.getKubeconfigPath(cluster)); },
    helm: async (cluster, args) => String(await kubeInfra.runHelm(args, await clusterService.getKubeconfigPath(cluster))),
  });
  const engineFiles = new FileService({ store: db, open: (ownerId, place) => fileStores.open(ownerId, place), defaultCluster: DEFAULT_TARGET_CLUSTER });
  const host = createEngineHost({
    files: {
      files: engineFiles,
      projects: async (ownerId) => (await db.projects.getProjects()).filter((project) => project.ownerId === ownerId),
      projectOfTree: async (ownerId, treeId) => (await db.projects.getTrees()).find((tree) => tree.id === treeId && tree.ownerId === ownerId)?.projectIds?.[0],
      projectOfConversation: async (ownerId, conversationId) => (await db.engine.getConversation(ownerId, conversationId))?.projectId,
    },
    dependencies: async (ownerId) => catalogueOf(SHIPPED_DEPENDENCIES, await db.engine.getWorkspaceDependencies(ownerId)),
    accountDefault: async (ownerId) => accountDefaultOf(await db.accounts.getUserById(ownerId)),
    customizations,
    monitoring: {
      monitoring,
      rules: (ownerId) => db.monitoring.getAlertRules(ownerId),
      viewer: async (ownerId) => ({ id: ownerId, isAdmin: Boolean((await db.accounts.getUserById(ownerId))?.isAdmin) }),
    },
    treeModels: {
      describe: (ownerId, treeId) => treeModels.describe(ownerId, treeId),
      problem: (ownerId, treeId, agent, modelId) => treeModels.problem(ownerId, treeId, agent, modelId),
    },
    releases: {
      cluster: createSlotCluster({ infra: kubeInfra, repo: async () => gitea, registry: () => gitea.registryLogin(), syncVault: syncVaultFromProject(kubeInfra), beat: activityBeat }),
      adapters: { [ODOO_RELEASE_ADAPTER.id]: ODOO_RELEASE_ADAPTER },
      releases: { list: (ownerId, projectId) => db.releases.getOdooReleases(ownerId, projectId), save: (release) => db.releases.saveOdooRelease(release) },
      browserTests: (request) => releaseBrowser.ReleaseBrowserTestsActivity(request),
      images: {
        deploy: async (projectId, pipelineRunId) => {
          const project = (await db.projects.getProjects()).find((entry) => entry.id === projectId);
          const run = (await db.releases.getPipelineRuns()).find((entry) => entry.id === pipelineRunId);
          if (!project || !run) throw new Error(project ? `the build ${pipelineRunId} is gone` : `the project ${projectId} is gone`);
          const client = await getTemporalClient();
          const started = await deployProjectBuild({
            db,
            client: () => client,
            masterKey: keys.data,
            clusterById: async (id) => (id === DEFAULT_TARGET_CLUSTER ? clusterService.getSystemClusterEntry() : (await db.infrastructure.getClusters()).find((cluster) => cluster.id === id)),
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
    publishedWorkspaces: { get: (ownerId: string, treeId: string) => db.engine.getPublishedWorkspace(ownerId, treeId), save: (workspace) => db.engine.savePublishedWorkspace(workspace) },
    readRepoFile: async (ownerId: string, repo: string, path: string, ref: string) => (await projectRepos.readDocument(ownerId, repo, path, ref))?.content,
    writeRepoFile: (ownerId, repo, path, content, message, branch) => projectRepos.putDocument(ownerId, repo, path, content, message, branch),
    workspaceBuild: async (ownerId, treeId, commit) => {
      if (!builders.service) throw new Error('the workspace builder is not ready yet');
      return builders.service.start(ownerId, treeId, commit);
    },
    treeLanguage: treeLanguageFrom(db.projects),
    treeExtras: treeExtrasFrom(db.projects, dependencyNamespaceFrom(db.infrastructure)),
    artifacts: { keep: (ownerId, runId, files) => artifactStore.artifacts.put(ownerId, runId, files) },
    checks,
    documents: { push: (request) => projectRepos.pushDocuments(request), pull: (request) => projectRepos.pullDocuments(request), merge: (request) => projectRepos.mergeDocuments(request), pushBranch: (request) => projectRepos.pushBranch(request), pullBranch: (request) => projectRepos.pullBranch(request), deleteBranch: (request) => projectRepos.deleteBranch(request) },
    repoFor: createWorkspaceRepoResolver({ trees: () => db.projects.getTrees(), projects: () => db.projects.getProjects(), accountOf: async (ownerId) => (await db.projects.getGiteaAccount(ownerId))?.username }),
    hidden: (ownerId: string) => extensions.hidden(ownerId),
    published: (ownerId: string) => extensions.groups(ownerId),
    models,
    stores: { ...engineStores, grove: { ...engineStores.grove, growing: { start: (ownerId, treeId) => startOnceQuiet(groving(), ownerId, treeId), status: (treeId) => groving().groveRunStatus(treeId) } } },
    vault,
    egressSecret: keys.egress,
    corpus: {
      crawlerReady: async (ownerId) => (await db.infrastructure.getDeployments()).some((dep) => dep.appType === 'crawl4ai' && dep.status === 'running' && dep.ownerId === ownerId),
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
      pages: (filter) => db.engine.getCorpusPages({ ownerId: filter.ownerId, ...(filter.ingestId ? { ingestId: filter.ingestId } : {}) }),
    },
    projects: {
      projects: { list: () => db.projects.getProjects() },
      trees: { list: () => db.projects.getTrees() },
      binding: async (ownerId, conversationId) => {
        const conversation = await db.engine.getConversation(ownerId, conversationId);
        return conversation ? { treeId: conversation.treeId, projectId: conversation.projectId } : undefined;
      },
      runs: () => db.releases.getPipelineRuns(),
      deployments: () => db.infrastructure.getDeployments(),
      releases: (ownerId, projectId) => db.releases.getOdooReleases(ownerId, projectId),
      clusters: async (ownerId) => [
        await clusterService.getSystemClusterEntry(),
        ...(await db.infrastructure.getClusters()).filter((cluster) => cluster.ownerId === ownerId && !cluster.isSystem),
      ],
      appTypes: async (ownerId) => visibleAppSpecs(await db.infrastructure.getAppSpecs(), ownerId)
        .map((spec) => ({ id: spec.id, builtIn: spec.builtIn, ...(spec.label ? { label: spec.label } : {}), ...(spec.uiDefaults?.strategies ? { strategies: spec.uiDefaults.strategies } : {}) })),
      readPath: (project, path) => projectRepos.readPath(project, path),
      bindingCheck: async (ownerId, service, as) => {
        const dynamicTypes = await db.infrastructure.getBindingTypes().catch(() => []);
        const { bindings, problems } = resolveBindings([{ service, ...(as ? { as } : {}) }], await db.infrastructure.getDeployments(), await db.infrastructure.getAppSpecs(), ownerId, { dynamicTypes });
        const binding = bindings[0];
        return binding ? { name: binding.name, type: binding.type } : { problem: problems[0] ?? `cannot bind to "${service}"` };
      },
      proposals: { list: (ownerId) => db.engine.getActionProposals(ownerId), save: (proposal) => db.engine.saveActionProposal(proposal) },
    },
    kube: {
      clusters: async (ownerId) => [
        await clusterService.getSystemClusterEntry(),
        ...(await db.infrastructure.getClusters()).filter((cluster) => cluster.ownerId === ownerId && !cluster.isSystem),
      ],
      deployments: () => db.infrastructure.getDeployments(),
      kubectl: async (cluster, argv) => String(await kubeInfra.runKubectl(argv, await clusterService.getKubeconfigPath(cluster))),
      isAdmin: async (ownerId) => (await db.accounts.getUserById(ownerId))?.isAdmin === true,
      openNamespaces: async (ownerId, conversationId) => (await db.engine.getConversation(ownerId, conversationId))?.platformNamespaces ?? [],
      accessRequests: {
        list: (ownerId, conversationId) => db.infrastructure.getAccessRequests(ownerId, conversationId),
        save: (request) => db.infrastructure.saveAccessRequest(request),
      },
    },
    mcpServers: {
      list: (ownerId) => db.engine.getMcpServers(ownerId),
      get: async (ownerId, id) => (await db.engine.getMcpServers(ownerId)).find((server) => server.id === id),
      save: (server) => db.engine.saveMcpServer(server),
      hostedUrl: hostedMcpUrl({ deployments: () => db.infrastructure.getDeployments(), probeUrl: resolveMcpProbeUrl }),
    },
    ...(web ? { web } : {}),
    kubeconfig: process.env.KUBECONFIG_PATH,
    registryHost: process.env.KOALA_REGISTRY,
    pushRegistryHost: process.env.KOALA_REGISTRY_PUSH,
    registryAccount: async () => ({ owner: gitea.adminUsername, ...(await gitea.getAdminCredentials()) }),
    registryPushToken: async () => ({ username: gitea.adminUsername, password: (await gitea.createDeployToken()).token }),
    registryLogin: () => gitea.registryLogin(),
    onLeak: (runId, ageMs) => {
      logger.warn(`[engine] sandbox for ${runId} was still up ${Math.round(ageMs / 60_000)}m after it started, though its run has ended — tearing it down`);
    },
    runEnded: runEndedVia(() => getTemporalClient()),
  });
  const { registry, endpoints, environments, tools } = host;
  const autoMode = new AutoModeService({ store: db, agentExists: async (ownerId, slug) => Boolean(await registry.agent(ownerId, slug)) });
  const treeModels = new TreeModelsService({
    store: db.projects,
    models,
    agentOf: treeAgentsFrom(registry),
    machines: async (ownerId) => (await db.machines.getLocalAgentDevices())
      .filter((device) => device.ownerId === ownerId)
      .map((device) => ({ id: device.id, name: device.name, online: false, agents: device.agents ?? [] })),
    groups: platformGroups,
  });
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
    closing: async (ownerId: string) => ((await db.accounts.getUserById(ownerId))?.removal ? 'it is being removed' : undefined),
    machines: async (ownerId, choice) => {
      const device = (await db.machines.getLocalAgentDevices()).find((one) => one.id === choice.deviceId && one.ownerId === ownerId);
      return machineChoiceProblem(device ? { name: device.name, online: false, agents: device.agents ?? [] } : undefined, choice.agent, { waitsToConnect: true, model: choice.model });
    },
  });
  builders.service = new WorkspaceBuildService({ runs: runStarter, trees: () => db.projects.getTrees(), hidden: (ownerId: string) => extensions.hidden(ownerId) });
  growers.launcher = createGroveLauncher({
    hidden: (ownerId: string) => extensions.hidden(ownerId),
    runs: runStarter,
    client: () => temporal.workflow,
    agentFor: async (ownerId: string, treeId: string) => {
      const tree = (await db.projects.getTrees()).find((entry) => entry.id === treeId && entry.ownerId === ownerId);
      return groveAgentOf(await resolveTreeType(db.projects, ownerId, tree?.type));
    },
    leafRun: async (leafId: string) => (await db.projects.getLeaves()).find((leaf) => leaf.id === leafId)?.runId,
    modelFor: (ownerId, treeId, agentSlug) => treeModels.modelFor(ownerId, treeId, agentSlug),
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
      list: (ownerId: string) => db.projects.getTasks(ownerId),
      save: (task: Task) => db.projects.saveTask(task),
    },
    treeWorkspaces: host.treeWorkspaces,
    ...(host.machineWork ? { machineWork: host.machineWork } : {}),
    machineName: async (ownerId, deviceId) => (await db.machines.getLocalAgentDevices()).find((device) => device.id === deviceId && device.ownerId === ownerId)?.name,
    conversationWorkspaces: host.conversationWorkspaces,
    conversationAgent: async (ownerId, conversationId) => (await db.engine.getConversation(ownerId, conversationId))?.agentSlug,
    allowedTools: async (ownerId, conversationId) => (await db.engine.getConversation(ownerId, conversationId))?.allowedTools ?? [],
    autoMode: (args) => autoMode.unasked({ ...args, treeId: args.workspaceRunId ? treeOfWorkspace(args.workspaceRunId) : undefined }),
    treeModel: async (ownerId, turnId, agentSlug) => {
      const treeId = treeOfGroveRun(turnId);
      return treeId ? treeModels.modelFor(ownerId, treeId, agentSlug) : undefined;
    },
    plans: { list: (ownerId) => db.projects.getPlanProposals(ownerId) },
    planAdoption: createPlanAdoption({
      stores: {
        proposals: { get: (ownerId, id) => db.projects.getPlanProposal(ownerId, id), save: (proposal) => db.projects.savePlanProposal(proposal) },
        trees: { list: () => db.projects.getTrees(), save: (tree) => db.projects.saveTree(tree) },
        branches: { list: () => db.projects.getBranches(), save: (branch) => db.projects.saveBranch(branch) },
        leaves: { list: () => db.projects.getLeaves(), save: (leaf) => db.projects.saveLeaf(leaf) },
        tasks: { list: (ownerId) => db.projects.getTasks(ownerId), save: (task) => db.projects.saveTask(task) },
        conversations: { bind: (ownerId, conversationId, binding) => db.engine.bindConversation(ownerId, conversationId, binding) },
      },
      treeWorkspaces: host.treeWorkspaces,
      environments: host.environments,
      // So a tree this adoption creates starts from its type's scaffold rather than an empty repo.
      treeTypes: (ownerId: string) => db.projects.getTreeTypes(ownerId),
      registryHost: process.env.KOALA_REGISTRY,
      homeTree: (tree) => treeHome.home(tree, { starter: false }),
      projectChoices: async (_ownerId, projectId, choices) => {
        const project = (await db.projects.getProjects()).find((entry) => entry.id === projectId);
        if (project) await db.projects.saveProjectInfo(projectChoicesPatch(project as { id: string; clientImport?: ClientImport }, choices, new Date().toISOString()));
      },
      stopRun: async (workflowId: string) => { await stopIfRunning(temporal.workflow.getHandle(workflowId), 'the story it was working changed'); },
      ...(host.checkNeeds ? { checkNeeds: host.checkNeeds } : {}),
    }),
    grove: {
      trees: { list: () => db.projects.getTrees() },
      branches: { list: () => db.projects.getBranches() },
      leaves: { list: () => db.projects.getLeaves(), save: (leaf) => db.projects.saveLeaf(leaf) },
      tasks: { list: () => db.projects.getTasks() },
      // Where a run reads the stages its tree type names. Without this the worker sees no types at
      // all, and every stage quietly falls back to its default whatever the person chose.
      treeTypes: async (ownerId: string) => treeTypeChoices(await db.projects.getTreeTypes(ownerId), ownerId),
    },
    effort: createEffortTracker({
      models,
      registry,
      store: {
        save: (effort) => db.engine.saveRunEffort(effort),
        list: (ownerId, procedureId, modelKey) => db.engine.getRunEffort(ownerId, procedureId, modelKey),
      },
    }),
    traces: {
      record: ({ ownerId, runId, agentSlug, procedureId, procedureVersion, traces }: RecordTracesArgs) =>
        db.engine.saveRunTraces(traces.map((trace) => ({ ...trace, ownerId, runId, agentSlug, procedureId, procedureVersion }))),
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
    clusterById: async (id) => (id === DEFAULT_TARGET_CLUSTER ? clusterService.getSystemClusterEntry() : (await db.infrastructure.getClusters()).find((cluster) => cluster.id === id)),
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
      files: {
        removeAll: async (ownerId, place) => {
          try {
            await (await fileStores.open(ownerId, place)).removeAll();
            return 'removed';
          } catch (err) {
            if (err instanceof FileServerUnreachableError) return 'unreachable';
            throw err;
          }
        },
      },
    }),
    ReleaseBrowserTestsActivity: releaseBrowser.ReleaseBrowserTestsActivity,
    ...createCheckRunActivities({
      store: db,
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
        cluster: namespacedCluster(kubeInfra, () => gitea.registryLogin()),
        project: async (id) => (await db.projects.getProjects()).find((project) => project.id === id),
        clusterById: async (id) => (id === DEFAULT_TARGET_CLUSTER ? clusterService.getSystemClusterEntry() : (await db.infrastructure.getClusters()).find((cluster) => cluster.id === id)),
      }),
      terminate: async (runId, reason) => { await temporal.workflow.getHandle(workflowOfRun(runId)).terminate(reason).catch(() => undefined); },
      leftovers: {
        records: (ownerId) => db.accounts.accountLeftovers(ownerId),
        workspaces: async (ownerId) => (await createKubeRunner()(['get', 'namespace', '-l', `koala.dev/owner=${labelValue(ownerId)}`, '-o', 'name'])).stdout.split('\n').map((line) => line.trim()).filter(Boolean),
        giteaUser: (ownerId) => gitea.userExists(giteaUsernameFor(ownerId)),
      },
      reported: (run, says, answer) => wasReported(createProcedureExecutor(host.services, { registry: host.registry }), { runId: run.runId, ownerId: run.spaceId, agent: run.agent, modelId: run.modelId }, says, answer),
      says: (run, means, answer, index) => itSays(createProcedureExecutor(host.services, { registry: host.registry }), { runId: run.runId, ownerId: run.spaceId, agent: run.agent, modelId: run.modelId }, means, answer, index),
    }),
    ...createCheckProgressActivity(db.checks as never),
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
