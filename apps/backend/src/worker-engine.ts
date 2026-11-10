#!/usr/bin/env node
import { machineChoiceProblem, accountDefaultOf } from './machines/index.js';
import {
  catalogueOf, AutoModeService, mcpReachFrom, extensionServiceFor, RunGrantService, WorkspaceBuildService, hostedMcpUrl,
} from './engine/index.js';
import { startOnceQuiet } from './engine-host/grove-launcher.js';
import { SHIPPED_DEPENDENCIES } from './extensions/workspace-dependencies.js';
import path from 'path';
import {
  koalasClusterFor, GiteaService, projectSecretsFor, ProjectChannelService, ODOO_TREE_TYPE,
  treeTypeOfProject, giteaUsernameFor, ProjectRepoService, createSecretVault, treeTypeChoices, treeLanguageFrom,
  treeExtrasFrom, dependencyNamespaceFrom, ownNamespacesFrom, renderStarterFiles, groveAgentOf, resolveTreeType, versionVars,
  TreeHomeService, webhookUrlAt, type GroveRunLauncher,
} from './projects/index.js';
import {
  stopIfRunning, createDatabase, sharedPayloadBlobs, createWorkerLogger, buildDataConverter, connectTemporalWorker, temporalTlsProblem, failureReason,
  sessionToken, principalOf, claimsOf, claimSettingsFrom, getTemporalClient, resolveOwnersWith, startedFor, carryingTrace, telemetrySettings, AccessRevocations,
  publicAddressProblem, encryptValue, engineWorkerSettingsFrom, connectTemporalAs, keepPayloadsIn, reopening, SettingsError, type EngineWorkerSettings, type DependencyStates,
} from './platform/index.js';
import type { ClaimedUser } from './platform/index.js';
import { rootSignInFor } from './instances/wiring/sign-in.js';
import { createWorkspaceRepoResolver, treeOfWorkspace } from './engine-host/sandboxes/workspace-repos.js';
import dotenv from 'dotenv';
import { Worker, Runtime } from '@temporalio/worker';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { createPlanAdoption } from './engine-host/plan-adoption.js';
import {
  LOG_DIR, InfisicalService, HeadscaleService, deployProjectBuild, sharedClusterProxy, InfrastructureService, terraformPlacesFor,
  ClusterService, clusterAccessFrom, visibleAppSpecs, resolveBindings, serveHealth,
} from './infrastructure/index.js';
import { createModelService } from './models/wiring/model-wiring.js';
import { createAccountRemovalActivities, removalMeshFor } from './activities/RemoveAccountActivities.js';
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
import { scriptedModelBase, httpCheckAccess } from './checks/index.js';
import { labelValue } from './engine-host/sandboxes/workspace.js';
import { itSays, wasReported } from './eval/level2/reported.js';
import { createProcedureExecutor } from './engine-host/nodes/index.js';
import axios from 'axios';
import { poolMonitor, poolMonitorFrom, collectorEndpoint, collectorSink } from './monitoring/index.js';
import { checkServices, collectorAnswers, reportCollectorTo, workerDependencies } from './platform/wiring/dependencies.js';
import { monitoringServiceFor } from './monitoring/wiring/monitoring.js';
import { runCancelledVia, runEndedVia } from './engine-host/temporal/run-cancellation.js';
import { createKubeRunner, onKoalasCluster } from './engine-host/sandboxes/kube.js';

import { createEventBus } from '@koala/agent-engine';
import type { MachineChoice } from '@koala/agent-engine/procedure';
import {
  createEngineActivities,
  createEffortTracker,
  createEngineHost,
  PoisoningWatch,
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
import { storedFilesFor } from './files/wiring/files.js';
import { bindChatWithItsFiles } from './files/index.js';
import { treeOfGroveRun, workflowOfRun } from './engine-host/temporal/contracts.js';
import { TreeModelsService, treeAgentsFrom } from './models/index.js';
import { platformGroups } from './extensions/installed.js';
import { classifiedFailures, heartbeatWhileRunning, WORKER_DEFAULTS } from '@koala/engine-core';
import { ignore } from '@koala/engine-core/failures';
import { traceActivities } from '@koala/engine-core/telemetry';
import { startTelemetry } from '@koala/engine-core/telemetry-sdk';
import { executeIngestWorkflow } from './workflows/IngestWorkflow.js';
import { workflowInterceptorModules } from './worker-interceptors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

dotenv.config({ quiet: true });

const logger = createWorkerLogger('engine-worker');

async function buildActivities(settings: EngineWorkerSettings, dependencies: DependencyStates) {
  const { keys, tenant } = settings;
  const db = createDatabase({ mongo: settings.mongo, dataKey: keys.data });
  db.reportReachTo(dependencies);
  await db.init();
  resolveOwnersWith(async (owner) => (await db.accounts.getUserById(owner))?.space?.person ?? owner);

  const models = createModelService({ db, dataKey: keys.data, role: settings.role, clusters: settings.clusters, infra: new InfrastructureService(terraformPlacesFor({ off: 'the engine worker runs no Terraform; the cluster worker does' })), mesh: settings.mesh, endpointRules: { scriptedBase: scriptedModelBase(tenant.checksApi), lab: settings.lab } });
  const clusterAccess = clusterAccessFrom(settings.clusters, { role: settings.role.role, clusters: db.infrastructure, dataKey: keys.data });
  const web = await buildWebTools({ db, proxy: sharedClusterProxy(clusterAccess), settings: tenant.webTools, dependencies });

  const giteaAt = tenant.gitea;
  const imageRegistry = tenant.registry;
  const gitea = new GiteaService(keys.data, giteaAt, { registryPullHost: tenant.registryPullHost, reportsTo: dependencies });
  const infisical = new InfisicalService(keys.data, tenant.infisical, dependencies);
  const projectRepos = new ProjectRepoService(db, gitea, keys.data, async (projectId) => webhookUrlAt(giteaAt.reachesKoalaAt, projectId), { defaultCluster: koalasClusterFor(settings.clusters.here) });
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
      bind: bindChatWithItsFiles(db),
      trees: () => db.projects.getTrees(),
      saveProjectInfo: (entry) => db.projects.saveProjectInfo(entry),
    }).ensure(project),
  });
  const clusterService = new ClusterService(db, clusterAccess, { instanceOwnerId: settings.role.instance?.ownerId });
  const onKoala = onKoalasCluster(clusterAccess, () => clusterAccess.own().clusterId);
  const sandboxKube = createKubeRunner(onKoala);
  const instanceFiles = storedFilesFor({ db, minio: tenant.minio, workflows: async () => (await getTemporalClient()).workflow, engineTaskQueue: settings.queues.engine || DEFAULT_ENGINE_TASK_QUEUE, dataDir: resolve(__dirname, '../data'), dependencies });
  const vault = createSecretVault({
    backend: infisical,
    minters: { readToken: async (ownerId) => (await projectRepos.mintReadToken(ownerId)).token },
  });
  const extensions = extensionServiceFor(db);
  const checksApi = tenant.checksApi;
  const checks = httpCheckAccess(async (ownerId) => {
    const person = await db.accounts.getUserById(ownerId);
    if (!person) throw new Error(`there is no account ${ownerId} to act for`);
    return carryingTrace(axios.create({ baseURL: checksApi, proxy: false, headers: { Cookie: actingAs(person, 60 * 60) } }));
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
    cluster: namespacedCluster(clusterService.access, () => gitea.registryLogin()),
    specs: async () => gitea,
    keep: (ownerId, runId, files) => instanceFiles.artifacts.put(ownerId, runId, files),
  });
  const customizations = new CustomizationsService({
    projects: () => db.projects.getProjects(),
    clusterById: (id) => clusterService.getByIdUnscoped(id),
    how: async (project) => releaseHowOf(project, await treeTypeOfProject(db.projects, project), true),
    cluster: createSlotCluster({ access: clusterService.access, repo: async () => gitea, registry: () => gitea.registryLogin(), syncVault: syncVaultFromProject(infisical, { mongo: settings.mongo, dataKey: keys.data }) }),
    adapters: { [ODOO_RELEASE_ADAPTER.id]: ODOO_RELEASE_ADAPTER },
    trees: () => db.projects.getTrees(),
    branches: () => db.projects.getBranches(),
    leaves: () => db.projects.getLeaves(),
    tasks: (ownerId) => db.projects.getTasks(ownerId),
    savePlan: (proposal) => db.projects.savePlanProposal(proposal),
    treeTypeOf: async (project) => (await treeTypeOfProject(db.projects, project))?.id ?? ODOO_TREE_TYPE,
  });
  const engineRole = settings.role;
  const rootSignIn = rootSignInFor({ role: engineRole, instanceCredential: settings.instanceCredential, keys, db, revocations: new AccessRevocations(), publicUrl: settings.publicUrl });
  rootSignIn?.keepAnnouncing((message) => console.warn(`[sign-in] ${message}`));
  const actingAs = (person: ClaimedUser & { email: string }, seconds?: number): string =>
    `session=${engineRole.role === 'instance' && rootSignIn
      ? rootSignIn.madeHere(person, claimsOf(person, claimSettingsFrom(engineRole)), seconds)
      : sessionToken(person, keys.session, seconds ? { seconds } : {})}`;
  const placeOnPool = poolMonitorFrom(settings.poolMonitor, rootSignIn ? () => rootSignIn.serviceToken() : undefined);
  const monitoring = monitoringServiceFor({ db, clusters: clusterService, proxy: sharedClusterProxy(clusterAccess), pool: placeOnPool ? poolMonitor(placeOnPool) : undefined });
  const runGrants = new RunGrantService({ store: db.engine });
  const poisoning = new PoisoningWatch({
    store: db.engine,
    personText: async (ownerId, conversationId) => (conversationId
      ? ((await db.engine.getConversation(ownerId, conversationId))?.messages ?? []).filter((message) => message.role === 'user').map((message) => message.content).join('\n')
      : ''),
    seal: (text) => encryptValue(text, keys.data),
    log: (message) => logger.warn(message),
  });
  const host = createEngineHost({
    poisoning,
    runGrants: {
      callProblem: (grantId, tool, projectId) => runGrants.callProblem(grantId, tool, projectId),
      keepHandover: (ownerId, runId, handover) => runGrants.keepHandover(ownerId, runId, handover),
    },
    files: {
      files: instanceFiles.fileService,
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
      viewer: async (ownerId) => principalOf((await db.accounts.getUserById(ownerId)) ?? { id: ownerId }, claimSettingsFrom(engineRole)),
    },
    treeModels: {
      describe: (ownerId, treeId) => treeModels.describe(ownerId, treeId),
      problem: (ownerId, treeId, agent, modelId) => treeModels.problem(ownerId, treeId, agent, modelId),
    },
    releases: {
      cluster: createSlotCluster({ access: clusterService.access, repo: async () => gitea, registry: () => gitea.registryLogin(), syncVault: syncVaultFromProject(infisical, { mongo: settings.mongo, dataKey: keys.data }), beat: activityBeat }),
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
            clusterById: (id) => clusterService.getByIdUnscoped(id),
            handOver: (id) => clusterService.access.handOver(id),
            ownClusterId: () => clusterService.ownClusterId(),
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
    treeExtras: treeExtrasFrom(db.projects, dependencyNamespaceFrom(db.infrastructure), ownNamespacesFrom(db.infrastructure)),
    artifacts: { keep: (ownerId, runId, files) => instanceFiles.artifacts.put(ownerId, runId, files) },
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
      addressProblem: publicAddressProblem,
      crawlerReady: async (ownerId) => (await db.infrastructure.getDeployments()).some((dep) => dep.appType === 'crawl4ai' && dep.status === 'running' && dep.ownerId === ownerId),
      start: async (workflowId, args) => {
        await (await getTemporalClient()).workflow.start(executeIngestWorkflow, { taskQueue: 'host-ops-queue', workflowId, args: [args], ...startedFor(args.ownerId) });
      },
      status: async (workflowId) => {
        try {
          const handle = (await getTemporalClient()).workflow.getHandle<typeof executeIngestWorkflow>(workflowId);
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
      clusters: (ownerId) => clusterService.clustersOwnedBy(ownerId),
      ownClusterId: () => clusterService.ownClusterId(),
      appTypes: async (ownerId) => visibleAppSpecs(await db.infrastructure.getAppSpecs(), ownerId)
        .map((spec) => ({ id: spec.id, builtIn: spec.builtIn, ...(spec.label ? { label: spec.label } : {}), ...(spec.uiDefaults?.strategies ? { strategies: spec.uiDefaults.strategies } : {}) })),
      readPath: (project, path) => projectRepos.readPath(project, path),
      bindingCheck: async (ownerId, service, as) => {
        const dynamicTypes = await db.infrastructure.getBindingTypes().catch((err: Error) => {
          console.warn(`[bindings] the binding types people added could not be read, so only the built-in ones are checked: ${err.message}`);
          return [];
        });
        const { bindings, problems } = resolveBindings([{ service, ...(as ? { as } : {}) }], await db.infrastructure.getDeployments(), await db.infrastructure.getAppSpecs(), ownerId, { dynamicTypes });
        const binding = bindings[0];
        return binding ? { name: binding.name, type: binding.type } : { problem: problems[0] ?? `cannot bind to "${service}"` };
      },
      proposals: { list: (ownerId) => db.engine.getActionProposals(ownerId), save: (proposal) => db.engine.saveActionProposal(proposal) },
    },
    kube: {
      clusters: (ownerId) => clusterService.clustersOwnedBy(ownerId),
      ownClusterId: () => clusterService.ownClusterId(),
      deployments: () => db.infrastructure.getDeployments(),
      kubectl: (cluster, argv) => clusterAccess.kubectl(cluster.id, argv),
      principal: async (ownerId) => principalOf((await db.accounts.getUserById(ownerId)) ?? { id: ownerId }, claimSettingsFrom(engineRole)),
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
      hostedUrl: hostedMcpUrl({ deployments: () => db.infrastructure.getDeployments(), probeUrl: mcpReachFrom({ access: clusterAccess, clusterById: (id) => clusterService.getByIdUnscoped(id) }).url, urlProblem: publicAddressProblem }),
    },
    ...(web ? { web } : {}),
    cluster: onKoala,
    registry: imageRegistry,
    reportsTo: dependencies,
    registryAccount: async () => ({ owner: gitea.adminUsername, ...(await gitea.getAdminCredentials()) }),
    registryPushToken: async () => {
      const token = await gitea.createDeployToken();
      return { username: gitea.adminUsername, password: token.token, name: token.name };
    },
    revokeRegistryPushToken: (name: string) => gitea.revokeToken(name),
    registryLogin: () => gitea.registryLogin(),
    onLeak: (runId, ageMs) => {
      logger.warn(`[engine] sandbox for ${runId} was still up ${Math.round(ageMs / 60_000)}m after it started, though its run has ended — tearing it down`);
    },
    runEnded: runEndedVia(() => getTemporalClient(), dependencies),
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
  const machineProblem = async (ownerId: string, choice: MachineChoice): Promise<string | undefined> => {
    const device = (await db.machines.getLocalAgentDevices()).find((one) => one.id === choice.deviceId && one.ownerId === ownerId);
    return machineChoiceProblem(device ? { name: device.name, online: false, agents: device.agents ?? [] } : undefined, choice.agent, { waitsToConnect: true, model: choice.model });
  };
  const runStarter = createRunStarter({
    principal: async (ownerId) => principalOf((await db.accounts.getUserById(ownerId)) ?? { id: ownerId }, claimSettingsFrom(engineRole)),
    grants: runGrants,
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
    machines: machineProblem,
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
    projectOf: async (ownerId: string, treeId: string) => (await db.projects.getTrees()).find((entry) => entry.id === treeId && entry.ownerId === ownerId)?.projectIds?.[0],
  });

  const sweeper = setInterval(() => {
    host.runEnvironments.sweep().catch((err: Error) => {
      logger.warn(`[engine] the sandbox sweep could not ask Temporal which runs ended, so it removes none this time: ${err.message}`);
    });
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
    runCancelled: runCancelledVia(() => getTemporalClient(), dependencies),
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
    machineProblem,
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
        conversations: { bind: bindChatWithItsFiles(db) },
      },
      treeWorkspaces: host.treeWorkspaces,
      environments: host.environments,
      // So a tree this adoption creates starts from its type's scaffold rather than an empty repo.
      treeTypes: (ownerId: string) => db.projects.getTreeTypes(ownerId),
      registryHost: imageRegistry.pull,
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
    clusterById: (id) => clusterService.getByIdUnscoped(id),
    handOver: (id) => clusterService.access.handOver(id),
    logFile: () => path.join(LOG_DIR, `${Date.now()}-${Math.random().toString(36).slice(2)}-D4.log`),
    taskQueue: 'cluster-ops-queue',
  };
  return {
    ...engine,
    ...createAccountRemovalActivities({
      store: db,
      apps: appTeardown,
      workflows: removalWorkflows,
      kube: sandboxKube,
      repositories: gitea,
      mesh: removalMeshFor(engineRole, () => new HeadscaleService(keys.data, settings.mesh)),
      secrets: infisical,
      files: instanceFiles.storedFiles,
    }),
    ...createProjectRemovalActivities({
      store: db,
      apps: appTeardown,
      workflows: removalWorkflows,
      kube: sandboxKube,
      repositories: gitea,
      secrets: infisical,
      artifacts: instanceFiles.artifacts,
      files: instanceFiles.fileService,
    }),
    ReleaseBrowserTestsActivity: releaseBrowser.ReleaseBrowserTestsActivity,
    ...createCheckRunActivities({
      store: db,
      api: (space) => carryingTrace(axios.create({
        baseURL: checksApi,
        proxy: false,
        headers: { Cookie: actingAs(space) },
      })),
      seedFiles: (ownerId, repo, files) => withSeedBundle(files, async (bundle) => {
        await projectRepos.pushDocuments({ ownerId, repo, describe: 'A check\'s conversation workspace', bundle });
      }),
      scripted: { base: scriptedModelBase(checksApi), dataKey: keys.data },
      ownClusterId: () => clusterService.ownClusterId(),
      releases: createCheckReleases({
        browser: releaseBrowser,
        cluster: namespacedCluster(clusterService.access, () => gitea.registryLogin()),
        project: async (id) => (await db.projects.getProjects()).find((project) => project.id === id),
        clusterById: (id) => clusterService.getByIdUnscoped(id),
      }),
      terminate: async (runId, reason) => {
        await temporal.workflow.getHandle(workflowOfRun(runId)).terminate(reason).catch((err: Error) => {
          console.warn(`[checks] the check could not kill ${runId} mid-turn, and judges the run as it ended: ${err.message}`);
        });
      },
      leftovers: {
        records: (ownerId) => db.accounts.accountLeftovers(ownerId),
        workspaces: async (ownerId) => {
          const listed = await sandboxKube(['get', 'namespace', '-l', `koala.dev/owner=${labelValue(ownerId)}`, '-o', 'name']);
          if (listed.exitCode !== 0) throw new Error(`the space's workspaces could not be listed: ${listed.stderr.trim() || `kubectl exited ${listed.exitCode}`}`);
          return listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
        },
        giteaUser: (ownerId) => gitea.userExists(giteaUsernameFor(ownerId)),
      },
      reported: (run, says, answer) => wasReported(createProcedureExecutor(host.services, { registry: host.registry }), { runId: run.runId, ownerId: run.spaceId, agent: run.agent, modelId: run.modelId }, says, answer),
      says: (run, means, answer, index) => itSays(createProcedureExecutor(host.services, { registry: host.registry }), { runId: run.runId, ownerId: run.spaceId, agent: run.agent, modelId: run.modelId }, means, answer, index),
    }),
    ...createCheckProgressActivity(db.checks as never),
  };
}

async function main() {
  const settings = engineWorkerSettingsFrom(process.env);
  const telemetry = startTelemetry(telemetrySettings(settings, 'koala-worker-engine'));
  const telemetryAccess = clusterAccessFrom(settings.clusters, { role: settings.role.role });
  const telemetryProxy = sharedClusterProxy(telemetryAccess);
  telemetry.exportTo(collectorSink({ otlpEndpoint: settings.telemetry.otlpEndpoint, proxy: telemetryProxy, koalasCluster: () => telemetryAccess.own().clusterId }));
  const dependencies = workerDependencies(settings, settings.mongo);
  reportCollectorTo(telemetry, dependencies);
  dependencies.checkWith('collector', collectorAnswers(settings.telemetry.otlpEndpoint ? () => settings.telemetry.otlpEndpoint : collectorEndpoint({ proxy: telemetryProxy, koalasCluster: () => telemetryAccess.own().clusterId })));
  checkServices(dependencies, { gitea: settings.tenant.gitea.url, infisical: settings.tenant.infisical.url, minio: settings.tenant.minio, registryPush: settings.tenant.registry.push, webTools: settings.tenant.webTools });
  Runtime.install({
    logger,
    telemetryOptions: {
      metrics: {
        prometheus: {
          bindAddress: `0.0.0.0:${settings.temporalMetricsPort}`,
        },
      },
    },
  });
  const plaintext = temporalTlsProblem(settings.temporal);
  if (plaintext) throw new Error(plaintext);
  connectTemporalAs(settings);
  keepPayloadsIn(settings.mongo);
  const queue = settings.queues.engine || DEFAULT_ENGINE_TASK_QUEUE;
  const { address } = settings.temporal;
  logger.info(`[EngineWorker] Starting — taskQueue=${queue}, address=${address}`);

  let activities: Awaited<ReturnType<typeof buildActivities>> | undefined;
  let current: Worker | undefined;
  if (settings.healthPort) serveHealth(settings.healthPort, () => current?.getState() === 'RUNNING');
  void dependencies.start();

  const connecting = reopening();
  for (;;) {
    try {
      activities ??= await buildActivities(settings, dependencies);
      const connection = await connectTemporalWorker('koala-worker-engine', settings);
      const dataConverter = buildDataConverter(settings.keys.payload, sharedPayloadBlobs());

      const worker = await Worker.create({
    ...WORKER_DEFAULTS,
        connection,
        namespace: settings.temporal.namespace,
        ...(dataConverter ? { dataConverter } : {}),
        taskQueue: queue,
        workflowsPath: resolve(__dirname, 'workflows'),
        interceptors: { activity: [heartbeatWhileRunning(), traceActivities(), classifiedFailures()], workflowModules: workflowInterceptorModules(settings.role) },
        activities,
      });
      current = worker;

      logger.info('[EngineWorker] Connected, polling for work');
      await worker.run();
      await telemetry.shutdown().catch(ignore('the worker has stopped, and telemetry the collector did not take is dropped as it is whenever the collector is away'));
      return;
    } catch (err) {
      if (activities) dependencies.failed('temporal', err);
      logger.error(`[EngineWorker] ${(err as Error).message} — retrying in ${connecting.seconds} s`);
      await connecting.after();
    }
  }
}

main().then(() => {
  logger.info('[EngineWorker] Stopped');
  process.exit(0);
}, (err) => {
  logger.error(err instanceof SettingsError ? `[EngineWorker] ${err.message}` : `[EngineWorker] fatal: ${(err as Error).message}`);
  process.exit(1);
});
