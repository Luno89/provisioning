import { randomUUID } from 'node:crypto';
import axios from 'axios';
import { WorkflowNotFoundError } from '@temporalio/client';
import type { Server as SocketServer } from 'socket.io';
import type { PersonaRecord } from '@koala/agent-engine';
import {
  type Database, type SecretKey, servesTenants, type RoleConfig, signJWT, startedFor, getTemporalClient,
  keepTrying, grovedTree, treeNotices, postedNotice, ownedBy,
} from '../../platform/index.js';
import { accountDefaultOf, type MachineService } from '../../machines/index.js';
import { PROCEDURE_CHANGE_AGENT } from '../lib/agent-usage.js';
import {
  fingerprintOf, scenarioSubjects, BenchService, Level2Service, temporalCheckRunner, ScriptedModelService,
  httpCheckAccess, checksRouter, evalsLevel2Router,
} from '../../checks/index.js';
import { providerServing, type ModelService, type TreeModelsService } from '../../models/index.js';
import { restoringApp, type wireReleases } from '../../releases/index.js';
import { hostedMcpUrl } from '../lib/mcp-hosted-url.js';
import { resolveMcpProbeUrl } from '../lib/mcp-probe-url.js';
import {
  treeTypeChoices, treeLanguageFrom, treeExtrasFrom, dependencyNamespaceFrom, TreeTypeDescriptions,
  type GiteaService, type ProjectRepoService, treeTypesRouter,
} from '../../projects/index.js';
import { type RunningRecords, type WorkFailureService, type TemporalBridge, bindingTypesRouter } from '../../infrastructure/index.js';
import { extensionServiceFor } from '../services/ExtensionService.js';
import { EngineToolService } from '../services/EngineToolService.js';
import { McpServerService } from '../services/McpServerService.js';
import { McpService } from '../services/McpService.js';
import { WorkspaceDependencyService } from '../services/WorkspaceDependencyService.js';
import { ConversationTurnService } from '../services/ConversationTurnService.js';
import { WorkspaceBuildService } from '../services/WorkspaceBuildService.js';
import { WorkspaceConclusionService, MemoryKeeperService, PracticeService, memoriesRouter } from '../../memory/index.js';
import { AgentService } from '../services/AgentService.js';
import { AgentChangeService } from '../services/AgentChangeService.js';
import { ProcedureService } from '../services/ProcedureService.js';
import { AutoModeService } from '../services/AutoModeService.js';
import { ApprovalService } from '../services/ApprovalService.js';
import { DocumentService } from '../services/DocumentService.js';
import { WorkspaceImageService } from '../services/WorkspaceImageService.js';
import type { ConversationNoticeService } from '../services/ConversationNoticeService.js';
import type { createArtifactService } from '../../files/index.js';
import {
  createStoredToolCatalogue, createEngineHost, storesFromDatabase, createStoredAgentRegistry, directoryFromDatabase, createEndpointResolver, createRunStarter, startStreamWorker,
} from '../../engine-host/index.js';
import { createModelNodes, hostNodesFor } from '../../engine-host/nodes/index.js';
import { createProcedureStore, stepNeedsReader } from '../../engine-host/registries/procedure-store.js';
import { conversationBinding } from '../../engine-host/conversation-binding.js';
import { createWorkspaceRepoResolver } from '../../engine-host/sandboxes/workspace-repos.js';
import { PRUNE_FIRST_DELAY_MS, PRUNE_INTERVAL_MS } from '../../engine-host/sandboxes/prune-images.js';
import { runCancelledVia } from '../../engine-host/temporal/run-cancellation.js';
import { BENCH_IDLE_WORKFLOW, CONVERSATION_CONCLUSION_WORKFLOW, DEFAULT_ENGINE_TASK_QUEUE, benchIdleId, conversationConclusionId, treeOfGroveRun, workflowOfRun } from '../../engine-host/temporal/contracts.js';
import { MCP_SERVER_TEMPLATES } from '../../extensions/mcp/templates.js';
import { buildWebTools } from './web-tools.js';
import type { Mounts } from '../../hub/index.js';
import { proceduresRouter } from '../routes/procedures.js';
import { engineRouter } from '../routes/engine.js';
import { engineToolsRouter } from '../routes/engine-tools.js';
import { agentsRouter } from '../routes/agents.js';
import { conversationsRouter } from '../routes/conversations.js';
import { documentsRouter } from '../routes/documents.js';
import { turnsRouter } from '../routes/turns.js';
import { autoModeRouter } from '../routes/auto-mode.js';
import { workspaceDependenciesRouter } from '../routes/workspace-dependencies.js';
import { mcpRouter } from '../routes/mcp.js';
import type { RequestHandler } from 'express';

export interface EngineCoreDeps {
  db: Database;
  env: NodeJS.ProcessEnv;
  temporalBridge: TemporalBridge;
  machines: Pick<MachineService, 'choiceProblem'>;
  checks: () => Pick<Level2Service, 'list'> | undefined;
}

export interface EngineCore {
  extensions: ReturnType<typeof extensionServiceFor>;
  dependencyFollowers: { tools?: EngineToolService; servers?: McpServerService };
  workspaceDependencies: WorkspaceDependencyService;
  dependenciesOf: (ownerId: string) => ReturnType<WorkspaceDependencyService['catalogue']>;
  agentDirectory: ReturnType<typeof directoryFromDatabase>;
  engineRegistry: ReturnType<typeof createStoredAgentRegistry>;
  conversationTurns: ConversationTurnService;
  engineRuns: ReturnType<typeof createRunStarter>;
  workspaceBuilds: WorkspaceBuildService;
  bench: { service?: BenchService };
  agentsHolder: { service?: AgentService };
  workspaceRepos: ReturnType<typeof createWorkspaceRepoResolver>;
  workspaceConclusions: WorkspaceConclusionService;
  memoryKeeper: MemoryKeeperService;
  reportMemory: (why: string) => (report: { started: string[] }) => void;
  concluded: (ownerId: string, conversationId: string | undefined) => void;
  runningRecords: (ownerId: string) => Promise<RunningRecords>;
}

export function engineCore(deps: EngineCoreDeps): EngineCore {
  const { db, env, temporalBridge } = deps;
  const engineQueue = env.TEMPORAL_ENGINE_TASK_QUEUE || DEFAULT_ENGINE_TASK_QUEUE;
  const extensions = extensionServiceFor(db);
  const dependencyFollowers: { tools?: EngineToolService; servers?: McpServerService } = {};
  const workspaceDependencies = new WorkspaceDependencyService({
    store: db.engine,
    tools: (ownerId) => db.engine.getEngineTools(ownerId),
    servers: (ownerId) => db.engine.getMcpServers(ownerId),
    workspaces: async (ownerId) => {
      const [published, trees] = await Promise.all([db.engine.getPublishedWorkspaces(ownerId), db.projects.getTrees()]);
      const names = new Map(trees.filter((tree) => tree.ownerId === ownerId).map((tree) => [tree.id, tree.name]));
      return published.map((workspace) => ({ ...workspace, treeName: names.get(workspace.treeId) }));
    },
    changed: async (ownerId, _name, use) => {
      if (use.tools.length) await dependencyFollowers.tools?.rebuildNeeding(ownerId, use.tools);
      const servers = await db.engine.getMcpServers(ownerId);
      for (const name of use.servers) {
        const server = servers.find((entry) => entry.name === name);
        if (server) await dependencyFollowers.servers?.recapture(ownerId, server.id);
      }
    },
  });
  const dependenciesOf = (ownerId: string) => workspaceDependencies.catalogue(ownerId);
  const bench: { service?: BenchService } = {};
  const agentsHolder: { service?: AgentService } = {};
  const agentDirectory = directoryFromDatabase(db.engine, {
    stepNeeds: stepNeedsReader({ sources: { list: (ownerId?: string) => db.engine.getProcedures(ownerId) }, published: (ownerId: string) => extensions.groups(ownerId) }),
    hidden: (ownerId: string) => extensions.hidden(ownerId),
    onChanged: (ownerId: string) => void bench.service?.changed(ownerId).catch(() => undefined),
  });
  const engineRegistry = createStoredAgentRegistry({
    agents: agentDirectory,
    procedures: { list: (ownerId?: string) => db.engine.getProcedures(ownerId) },
    hidden: (ownerId: string) => extensions.hidden(ownerId),
    published: (ownerId: string) => extensions.groups(ownerId),
    accountDefault: async (ownerId: string) => accountDefaultOf(await db.accounts.getUserById(ownerId)),
  });
  const conversationTurns = new ConversationTurnService({
    store: db.engine,
    log: db.engine,
    running: async (runId) => {
      if (!temporalBridge.isReady()) return true;
      try {
        return (await temporalBridge.client.workflow.getHandle(workflowOfRun(runId)).describe()).status.name === 'RUNNING';
      } catch (err) {
        if (err instanceof WorkflowNotFoundError) return false;
        throw err;
      }
    },
  });
  const engineRuns = createRunStarter({
    registry: engineRegistry,
    turns: conversationTurns,
    ...(Number(env.ENGINE_CONTINUE_AFTER_EVENTS) > 0 ? { continueAfterEvents: Number(env.ENGINE_CONTINUE_AFTER_EVENTS) } : {}),
    workflows: () => (temporalBridge.isReady()
      ? {
        start: async (type, options) => {
          const handle = await temporalBridge.client.workflow.start(type, {
            workflowId: options.workflowId,
            taskQueue: options.taskQueue,
            args: options.args,
            memo: options.memo,
            ...startedFor(options.owner),
          });
          return { workflowId: handle.workflowId };
        },
        signal: async (workflowId, name, payload) => {
          await temporalBridge.client.workflow.getHandle(workflowId)
            .signal(name, ...(payload === undefined ? [] : [payload]));
        },
      }
      : undefined),
    binding: conversationBinding(db),
    closing: async (ownerId: string) => ((await db.accounts.getUserById(ownerId))?.removal ? 'it is being removed' : undefined),
    machines: (ownerId, choice) => deps.machines.choiceProblem(ownerId, choice),
  });
  const workspaceBuilds = new WorkspaceBuildService({
    runs: engineRuns,
    trees: () => db.projects.getTrees(),
    hidden: (ownerId: string) => extensions.hidden(ownerId),
  });
  const workspaceRepos = createWorkspaceRepoResolver({ trees: () => db.projects.getTrees(), projects: () => db.projects.getProjects(), accountOf: async (ownerId) => (await db.projects.getGiteaAccount(ownerId))?.username });
  const workspaceConclusions = new WorkspaceConclusionService({
    workflows: async () => (await getTemporalClient()).workflow,
    taskQueue: engineQueue,
  });
  const memoryKeeper = new MemoryKeeperService({
    store: db,
    start: async (request) => { await engineRuns.start(request); },
    timer: async ({ ownerId, conversationId, signal, quietMs }) => {
      const workflows = (await getTemporalClient()).workflow;
      const where = {
        workflowId: conversationConclusionId(conversationId),
        taskQueue: engineQueue,
        args: [{ ownerId, conversationId }],
        ...startedFor(ownerId),
      };
      if (signal === 'turnEnded') await workflows.signalWithStart(CONVERSATION_CONCLUSION_WORKFLOW, { ...where, signal, signalArgs: [{ quietMs: quietMs ?? 0 }] });
      else await workflows.signalWithStart(CONVERSATION_CONCLUSION_WORKFLOW, { ...where, signal, signalArgs: [] });
    },
    concludeAfterMinutes: async (ownerId, agentSlug) => (await engineRegistry.agent(ownerId, agentSlug))?.concludeAfterMinutes,
    remembersFor: async (ownerId: string) => {
      const user = await db.accounts.getUserById(ownerId);
      return Boolean(user) && !user!.space && !user!.removal;
    },
  });
  const reportMemory = (why: string) => (report: { started: string[] }) => {
    if (report.started.length > 0) console.log(`[memory] ${why}: started ${report.started.join(', ')}`);
  };
  const concluded = (ownerId: string, conversationId: string | undefined): void => {
    void memoryKeeper.settled(ownerId, conversationId).then(reportMemory('a conversation settled')).catch((err: Error) => console.warn(`[memory] ${err.message}`));
  };
  const runningRecords = async (ownerId: string): Promise<RunningRecords> => {
    const checks = deps.checks();
    if (!checks) throw new Error('the checks are not wired yet');
    const [trees, projects, conversations, checkRuns, releases, agents] = await Promise.all([
      db.projects.getTrees(), db.projects.getProjects(), db.engine.getConversations(), checks.list(ownerId), db.releases.getOdooReleases(ownerId), agentDirectory.agents(ownerId),
    ]);
    return {
      trees: trees.filter((entry) => entry.ownerId === ownerId),
      projects: projects.filter((entry) => entry.ownerId === ownerId),
      conversations: conversations.filter((entry) => entry.ownerId === ownerId),
      checkRuns: checkRuns.map((run) => ({ id: run.id, trigger: run.trigger as { kind?: string; agents?: string[] } | undefined, finished: run.finished, scenarios: run.scenarios })),
      releases,
      agentName: (slug) => agents.find((agent) => agent.slug === slug)?.name,
    };
  };
  return {
    extensions, dependencyFollowers, workspaceDependencies, dependenciesOf, agentDirectory, engineRegistry, conversationTurns, engineRuns, workspaceBuilds,
    bench, agentsHolder, workspaceRepos, workspaceConclusions, memoryKeeper, reportMemory, concluded, runningRecords,
  };
}

type Releases = ReturnType<typeof wireReleases>;

export interface EngineWiringDeps {
  tenant: Mounts;
  db: Database;
  io: SocketServer;
  env: NodeJS.ProcessEnv;
  role: RoleConfig;
  sessionKey: SecretKey;
  dataKey: SecretKey;
  core: EngineCore;
  temporalBridge: TemporalBridge;
  models: ModelService;
  gitea: GiteaService;
  artifacts: ReturnType<typeof createArtifactService>;
  projectRepos: ProjectRepoService;
  customizations: Releases['customizations'];
  releaseSettings: Releases['releaseSettings'];
  treeModels: () => Pick<TreeModelsService, 'describe' | 'problem'>;
  requireAdmin: RequestHandler;
}

export interface EngineWiring {
  evalHost: ReturnType<typeof createEngineHost>;
  level2Service: Level2Service;
  procedureService: ProcedureService;
  autoModeService: AutoModeService;
  mcpCatalogue: McpServerService;
}

export async function wireEngine(deps: EngineWiringDeps): Promise<EngineWiring> {
  const { tenant, db, io, env, role, core, temporalBridge, gitea, projectRepos } = deps;
  const { extensions, dependenciesOf, agentDirectory, engineRegistry, engineRuns, workspaceBuilds, bench, agentsHolder, workspaceRepos, workspaceConclusions, conversationTurns } = core;
  const engineQueue = env.TEMPORAL_ENGINE_TASK_QUEUE || DEFAULT_ENGINE_TASK_QUEUE;
  const ownedTrees = async (userId: string) => ownedBy(await db.projects.getTrees(), userId);
  const ownedConversations = async (userId: string) => (await db.engine.getConversations()).filter((c) => c.ownerId === userId);

  tenant.use('/api/checks', checksRouter({ scripted: new ScriptedModelService({ store: db, dataKey: deps.dataKey }) }));

  const draftRegistry = createStoredAgentRegistry({
    agents: agentDirectory,
    procedures: { list: (ownerId?: string) => db.engine.getProcedures(ownerId) },
    tools: { list: (ownerId?: string) => db.engine.getEngineTools(ownerId) },
    hidden: (ownerId: string) => extensions.hidden(ownerId),
    published: (ownerId: string) => extensions.groups(ownerId),
  });
  const draftCatalogue = createStoredToolCatalogue({
    tools: { list: (ownerId?: string) => db.engine.getEngineTools(ownerId) },
  });

  const evalWeb = await buildWebTools(db).catch(() => undefined);
  const evalHost = createEngineHost({
    dependencies: dependenciesOf,
    customizations: { drift: (...args) => deps.customizations.drift(...args), propose: (...args) => deps.customizations.propose(...args), exportItems: (...args) => deps.customizations.exportItems(...args) },
    treeModels: {
      describe: (ownerId, treeId) => deps.treeModels().describe(ownerId, treeId),
      problem: (ownerId, treeId, agent, modelId) => deps.treeModels().problem(ownerId, treeId, agent, modelId),
    },
    mcpServers: {
      list: (ownerId) => db.engine.getMcpServers(ownerId),
      get: async (ownerId, id) => (await db.engine.getMcpServers(ownerId)).find((server) => server.id === id),
      save: (server) => db.engine.saveMcpServer(server),
      hostedUrl: hostedMcpUrl({ deployments: () => db.infrastructure.getDeployments(), probeUrl: resolveMcpProbeUrl }),
    },
    publishedWorkspaces: { get: (ownerId: string, treeId: string) => db.engine.getPublishedWorkspace(ownerId, treeId), save: (workspace) => db.engine.savePublishedWorkspace(workspace) },
    readRepoFile: async (ownerId: string, repo: string, path: string, ref: string) => (await projectRepos.readDocument(ownerId, repo, path, ref))?.content,
    writeRepoFile: (ownerId, repo, path, content, message, branch) => projectRepos.putDocument(ownerId, repo, path, content, message, branch),
    workspaceBuild: (ownerId, treeId, commit) => workspaceBuilds.start(ownerId, treeId, commit),
    treeLanguage: treeLanguageFrom(db.projects),
    treeExtras: treeExtrasFrom(db.projects, dependencyNamespaceFrom(db.infrastructure)),
    artifacts: { keep: (ownerId, runId, files) => deps.artifacts.artifacts.put(ownerId, runId, files) },
    checks: httpCheckAccess(async (ownerId) => {
      const person = await db.accounts.getUserById(ownerId);
      if (!person) throw new Error(`there is no account ${ownerId} to act for`);
      return axios.create({ baseURL: `http://localhost:${env.PORT || 3001}/api`, proxy: false, headers: { Cookie: `session=${signJWT({ userId: person.id, email: person.email }, deps.sessionKey, 60 * 60)}` } });
    }),
    documents: { push: (request) => projectRepos.pushDocuments(request), pull: (request) => projectRepos.pullDocuments(request), merge: (request) => projectRepos.mergeDocuments(request), pushBranch: (request) => projectRepos.pushBranch(request), pullBranch: (request) => projectRepos.pullBranch(request), deleteBranch: (request) => projectRepos.deleteBranch(request) },
    repoFor: workspaceRepos,
    hidden: (ownerId: string) => extensions.hidden(ownerId),
    published: (ownerId: string) => extensions.groups(ownerId),
    models: deps.models,
    stores: storesFromDatabase(db),
    owners: async () => (await db.accounts.getUsers()).map((user) => user.id),
    ...(evalWeb ? { web: evalWeb } : {}),
    kubeconfig: env.KUBECONFIG_PATH,
    registryHost: env.KOALA_REGISTRY,
    pushRegistryHost: env.KOALA_REGISTRY_PUSH,
    registryAccount: async () => ({
      owner: gitea.adminUsername,
      ...(await gitea.getAdminCredentials()),
    }),
    registryPushToken: async () => ({
      username: gitea.adminUsername,
      password: (await gitea.createDeployToken()).token,
    }),
    registryLogin: () => gitea.registryLogin(),
    efforts: { save: (effort) => db.engine.saveRunEffort(effort), list: (ownerId, procedureId, modelKey) => db.engine.getRunEffort(ownerId, procedureId, modelKey) },
  });

  const practiceService = new PracticeService({ store: db.memory });
  const toolNoteService = new PracticeService({ store: db.memory, category: 'tool_note' });
  const agentChanges = new AgentChangeService({
    store: db.checks,
    savePrompt: async (ownerId, slug, prompt) => {
      const current = await engineRegistry.agent(ownerId, slug);
      if (!current || !agentsHolder.service) return { saved: false, problems: [`there is no agent called "${slug}"`] };
      const saved = await agentsHolder.service.save(ownerId, { ...current, prompt });
      return saved.saved ? { saved: true } : { saved: false, problems: saved.problems };
    },
    handOff: async (ownerId, message) => {
      const at = new Date().toISOString();
      const conversationId = randomUUID();
      await db.engine.saveConversation({ id: conversationId, ownerId, title: 'Procedure change request', messages: [], agentSlug: PROCEDURE_CHANGE_AGENT, createdAt: at, updatedAt: at });
      const started = await engineRuns.start({ ownerId, agentSlug: PROCEDURE_CHANGE_AGENT, procedureId: 'interactive-chat', message, conversationId, inputs: { conversationId } });
      return { conversationId, runId: started.runId };
    },
  });
  const agentFingerprints = async (ownerId: string, agents: readonly string[]): Promise<Record<string, string>> => Object.fromEntries((await Promise.all(agents.map(async (slug) => {
    const runnable = await engineRegistry.runnable(ownerId, slug).catch(() => undefined);
    return runnable ? [slug, fingerprintOf({ agent: runnable.agent, procedure: runnable.procedure })] as const : undefined;
  }))).filter((entry): entry is readonly [string, string] => entry !== undefined));

  const level2Service: Level2Service = new Level2Service({
    fingerprints: agentFingerprints,
    checks: temporalCheckRunner(() => temporalBridge.client, engineQueue),
    tools: (ownerId: string) => draftCatalogue.list(ownerId),
    agents: async (ownerId: string) => (await draftRegistry.agents(ownerId)).map((agent) => agent.slug),
    procedures: async (ownerId: string) => (await engineRegistry.procedures(ownerId)).map((procedure) => procedure.id),
    store: db.checks,
    onFinished: async (run) => { await bench.service?.finished(run); },
  });

  bench.service = new BenchService({
    store: db,
    scenarios: async (ownerId) => (await level2Service.scenarios(ownerId)).map((scenario) => ({ id: scenario.id, agent: scenario.agent, onBench: scenario.onBench, tools: scenarioSubjects(scenario).tools })),
    fingerprints: agentFingerprints,
    practices: practiceService,
    notes: toolNoteService,
    changes: agentChanges,
    earlier: (run) => level2Service.earlier(run),
    notifyChange: (ownerId, change) => {
      io.to(`user:${ownerId}`).emit('agent-change-ready', { id: change.id, agent: change.agent, better: change.comparison?.better ?? [], worse: change.comparison?.worse ?? [] });
    },
    start: async (ownerId, plan, extra) => {
      const started = await level2Service.start({ ownerId, only: plan.scenarioIds, trigger: plan.trigger, ...extra });
      if ('unknown' in started) throw new Error(`the bench names scenarios that no longer exist: ${started.unknown.join(', ')}`);
      console.log(`[bench] ${ownerId}: started ${plan.trigger.kind} run ${started.id} (${plan.scenarioIds.length} scenarios)`);
    },
    serving: async (ownerId, model) => {
      const provider = providerServing(await deps.models.list(ownerId), model);
      return provider ? { modelId: provider.id, modelLabel: provider.name } : undefined;
    },
    benchRunning: async (ownerId) => (await level2Service.list(ownerId)).some((run) => run.state === 'running'),
    agentsRunning: async () => {
      const client = await getTemporalClient();
      for await (const _run of client.workflow.list({ query: 'WorkflowType = "AgentRunWorkflow" AND ExecutionStatus = "Running"' })) return true;
      return false;
    },
    idleTimer: async (ownerId, idleMs) => {
      await (await getTemporalClient()).workflow.signalWithStart(BENCH_IDLE_WORKFLOW, {
        workflowId: benchIdleId(ownerId),
        taskQueue: engineQueue,
        args: [{ ownerId }],
        ...startedFor(ownerId),
        signal: 'benchActivity',
        signalArgs: [{ idleMs }],
      });
    },
    notify: (ownerId, run) => {
      io.to(`user:${ownerId}`).emit('bench-regression', { runId: run.id, regressions: run.regressions ?? [], trigger: run.trigger });
    },
  });

  if (servesTenants(role)) await level2Service.recover().catch(() => undefined);

  void evalHost.workspaceImages.warm().then((images) => {
    const building = images.filter((image) => image.state === 'building');
    const failed = images.filter((image) => image.state === 'failed');
    if (building.length > 0) console.log(`[images] building ${building.length} workspace ${building.length === 1 ? 'image' : 'images'} ahead of the first run`);
    for (const image of failed) console.warn(`[images] ${image.agent}: ${image.detail ?? 'the image could not be built'}`);
  }).catch((err: Error) => console.warn(`[images] could not warm workspace images: ${err.message}`));

  const sweepImages = async (why: string): Promise<void> => {
    if (!evalHost.imagePruner) return;
    try {
      const report = await evalHost.imagePruner.prune();
      if (report.removed.length === 0 && report.failed.length === 0) return;
      console.log(`[images] ${why}: let go of ${report.removed.length}, kept ${report.kept.length}, left ${report.tooNew.length} too new`);
      for (const failure of report.failed) {
        console.warn(`[images] ${why}: could not delete ${failure.fingerprint.slice(0, 12)}: ${failure.detail}`);
      }
    } catch (err) {
      console.warn(`[images] ${why}: could not sweep the workspace images: ${(err as Error).message}`);
    }
  };
  if (servesTenants(role)) {
    setTimeout(() => { void sweepImages('after the warm'); }, PRUNE_FIRST_DELAY_MS).unref();
    setInterval(() => { void sweepImages('daily'); }, PRUNE_INTERVAL_MS).unref();
  }

  const procedureService = new ProcedureService({
    hidden: (ownerId: string) => extensions.hidden(ownerId),
    published: (ownerId: string) => extensions.groups(ownerId),
    procedures: createProcedureStore({ sources: { list: (ownerId?: string) => db.engine.getProcedures(ownerId) }, published: (ownerId: string) => extensions.groups(ownerId) }),
    sources: {
      get: (ownerId, id) => db.engine.getProcedure(ownerId, id),
      save: async (source) => {
        await db.engine.saveProcedure(source);
        if (source.ownerId) void bench.service?.changed(source.ownerId).catch(() => undefined);
      },
      delete: (ownerId, id) => db.engine.deleteProcedure(ownerId, id),
    },
    known: async (ownerId) => ({
      tools: await (async () => {
        const hidden = await extensions.hidden(ownerId);
        return new Set((await draftCatalogue.names(ownerId)).filter((name) => !hidden.tools.has(name)));
      })(),
      agents: new Set((await engineRegistry.agents(ownerId)).map((agent) => agent.slug)),
    }),
    effort: { list: (ownerId, procedureId) => db.engine.getRunEffort(ownerId, procedureId) },
  });
  tenant.use('/api/procedures', proceduresRouter({ procedures: procedureService }));

  const autoModeService = new AutoModeService({ store: db, agentExists: async (ownerId, slug) => Boolean(await engineRegistry.agent(ownerId, slug)) });
  tenant.use('/api/engine', engineRouter({
    runs: engineRuns,
    projects: async (ownerId) => (await db.projects.getProjects()).filter((project) => project.ownerId === ownerId).map((project) => ({ id: project.id, name: project.name })),
    approvals: new ApprovalService({ store: db.engine, runs: engineRuns, autoMode: autoModeService, treeOfRun: treeOfGroveRun }),
    registry: engineRegistry,
    admin: deps.requireAdmin,
    extensions,
    images: {
      standing: (ownerId?: string) => evalHost.workspaceImages.standing(ownerId),
      prune: async () => evalHost.imagePruner?.prune(),
    },
    traces: { list: (ownerId: string, runId: string) => db.engine.getRunTraces(ownerId, runId) },
    tasks: {
      list: (ownerId: string) => db.projects.getTasks(ownerId),
      save: (task) => db.projects.saveTask(task),
    },
    ...(evalHost.acceptedNeeds ? { accepted: evalHost.acceptedNeeds } : {}),
  }));

  tenant.use('/api/engine-tools', engineToolsRouter({
    tools: core.dependencyFollowers.tools = new EngineToolService({
      catalogue: draftCatalogue,
      dependencies: dependenciesOf,
      tools: {
        list: (ownerId?: string) => db.engine.getEngineTools(ownerId),
        save: (tool) => db.engine.saveEngineTool(tool),
        remove: (ownerId, name) => db.engine.deleteEngineTool(ownerId, name),
      },
      agents: agentDirectory,
      servers: (ownerId: string) => db.engine.getMcpServers(ownerId),
      implemented: evalHost.implemented,
      images: evalHost.images,
    }),
  }));

  tenant.use('/api/agents', agentsRouter({
    agents: agentsHolder.service = new AgentService({
      agents: agentDirectory,
      records: {
        save: async (record: PersonaRecord) => {
          await db.engine.saveEnginePersona(record);
          if (record.ownerId) void bench.service?.changed(record.ownerId).catch(() => undefined);
        },
        remove: (ownerId: string | undefined, slug: string) => db.engine.deleteEnginePersona(ownerId, slug),
      },
      tools: (ownerId: string) => draftCatalogue.list(ownerId),
      procedures: (ownerId: string) => engineRegistry.procedures(ownerId),
      treeTypes: async (ownerId: string) => treeTypeChoices(await db.projects.getTreeTypes(ownerId), ownerId),
      servers: (ownerId: string) => db.engine.getMcpServers(ownerId),
      dependencies: dependenciesOf,
      images: evalHost.images,
    }),
  }));

  tenant.use('/api/evals/level2', evalsLevel2Router({ level2: level2Service, bench: bench.service, practices: practiceService, notes: toolNoteService, changes: agentChanges }));

  tenant.use('/api/conversations', conversationsRouter({
    db,
    workspaces: {
      conclude: (ownerId: string, conversationId: string) => workspaceConclusions.conclude(ownerId, { kind: 'conversation', id: conversationId }),
      ...(evalHost.conversationWorkspaces ? { state: (conversationId: string) => evalHost.conversationWorkspaces!.state(conversationId) } : {}),
    },
    turns: conversationTurns,
    posted: (ownerId, conversationId) => { io.to(`user:${ownerId}`).emit('conversation-message', { conversationId }); },
    binding: conversationBinding(db),
    ownedConversations,
    ownedTrees,
    ownedProjects: async (userId: string) => (await db.projects.getProjects()).filter((project) => project.ownerId === userId),
  }));

  const documentService = new DocumentService({
    repoFor: workspaceRepos,
    owns: async (userId, kind, id) => (kind === 'tree'
      ? (await ownedTrees(userId)).some((tree) => tree.id === id)
      : (await ownedConversations(userId)).some((conversation) => conversation.id === id)),
    read: (userId, repo, path, ref) => projectRepos.readDocument(userId, repo, path, ref),
  });
  tenant.use('/api/documents', documentsRouter({ documents: documentService }));
  tenant.use('/api/turns', turnsRouter({ log: { read: (ownerId, turnId, after) => db.engine.getTurnLog(ownerId, turnId, after), recent: (ownerId, since, limit) => db.engine.recentTurns(ownerId, since, limit) } }));
  tenant.use('/api/memories', memoriesRouter({ db, temporalBridge }));

  const treeTypeDescriptions = new TreeTypeDescriptions({
    dependencies: dependenciesOf,
    releaseAgents: (ownerId) => deps.releaseSettings.agents(ownerId),
    restores: restoringApp,
    treeTypes: (ownerId) => db.projects.getTreeTypes(ownerId),
    images: (ownerId) => new WorkspaceImageService(db).list(ownerId),
    agentOf: async (ownerId, slug) => {
      const runnable = await engineRegistry.runnable(ownerId, slug);
      return runnable && { describe: runnable.agent.description, procedure: runnable.procedure };
    },
  });
  tenant.use('/api/tree-types', treeTypesRouter({
    db,
    agents: async (ownerId: string) => (await engineRegistry.agents(ownerId)).map((agent) => agent.slug),
    describe: (ownerId, typeId) => treeTypeDescriptions.describe(ownerId, typeId),
    releaseProblem: (ownerId, how) => deps.releaseSettings.problem(ownerId, how),
  }));
  tenant.use('/api/binding-types', bindingTypesRouter({ db: db.infrastructure }));
  tenant.use('/api/auto-mode', autoModeRouter({ autoMode: autoModeService }));

  const mcpCatalogue = core.dependencyFollowers.servers = new McpServerService({
    dependencies: dependenciesOf,
    store: { list: (ownerId) => db.engine.getMcpServers(ownerId), save: (server) => db.engine.saveMcpServer(server), remove: (ownerId, id) => db.engine.deleteMcpServer(ownerId, id) },
    templates: () => MCP_SERVER_TEMPLATES,
    runs: engineRuns,
    finished: async (runId) => db.engine.findRunEffort(runId),
    deployments: () => db.infrastructure.getDeployments(),
    grants: agentDirectory,
    notes: toolNoteService,
    names: async (ownerId, deployment) => {
      const project = deployment.gitappProjectId ? (await db.projects.getProjects()).find((entry) => entry.id === deployment.gitappProjectId && entry.ownerId === ownerId) : undefined;
      const tree = project ? (await db.projects.getTrees()).find((entry) => entry.ownerId === ownerId && (entry.projectIds ?? []).includes(project.id)) : undefined;
      return { ...(tree?.name ? { treeName: tree.name } : {}), ...(project?.name ? { projectName: project.name } : {}), declared: (tree as { serviceName?: unknown } | undefined)?.serviceName as string | undefined };
    },
  });
  tenant.use('/api/workspace-dependencies', workspaceDependenciesRouter({ dependencies: core.workspaceDependencies }));
  tenant.use('/api/mcp', mcpRouter({ mcp: new McpService({ store: db.engine, catalogue: (ownerId) => db.engine.getMcpServers(ownerId) }), catalogue: mcpCatalogue }));

  return { evalHost, level2Service, procedureService, autoModeService, mcpCatalogue };
}

export interface EngineStreamDeps {
  role: RoleConfig;
  io: SocketServer;
  db: Database;
  payloadKey: SecretKey;
  core: EngineCore;
  models: ModelService;
  notices: Pick<ConversationNoticeService, 'post'>;
  postNotice: (what: string, posting: Promise<unknown>) => void;
  workFailures: Pick<WorkFailureService, 'runEnded'>;
}

export function startEngineStream(deps: EngineStreamDeps): void {
  const { role, io, db, core } = deps;
  const { engineRegistry, memoryKeeper, bench, reportMemory } = core;
  if (!servesTenants(role)) return;
  void keepTrying('[engine] stream worker not started yet, runs do not stream until it is', async () => {
    const worker = await startStreamWorker({
      io,
      turnLogs: db.engine,
      encryptionKey: deps.payloadKey,
      services: {
        registry: engineRegistry,
        endpoints: createEndpointResolver({ models: deps.models, registry: engineRegistry }),
        streamNodes: hostNodesFor(createModelNodes({ registry: engineRegistry, models: deps.models }), ['stream']),
        runCancelled: runCancelledVia(() => getTemporalClient()),
        conclude: async (event) => {
          const grown = event.kind === 'run-ended' ? grovedTree(event.runId, event.depth) : undefined;
          if (event.kind === 'run-ended' && grown) {
            deps.postNotice('a tree stopped growing', (async () => {
              const tree = (await db.projects.getTrees()).find((entry) => entry.id === grown && entry.ownerId === event.ownerId);
              if (!tree) return;
              const branchIds = new Set((await db.projects.getBranches()).filter((branch) => branch.treeId === tree.id).map((branch) => branch.id));
              const leaves = (await db.projects.getLeaves()).filter((leaf) => branchIds.has(leaf.branchId));
              const projectId = tree.projectIds?.[0];
              for (const notice of treeNotices({ id: tree.id, name: tree.name, ...(projectId ? { projectId } : {}) }, leaves, { runId: event.runId, outcome: event.outcome, ...(event.reason ? { reason: event.reason } : {}) })) {
                await deps.notices.post(event.ownerId, { treeId: tree.id, projectId }, notice);
              }
            })());
          }
          if (event.kind === 'run-ended') await deps.workFailures.runEnded(event).catch((err: Error) => console.warn(`[failures] ${err.message}`));
          reportMemory(event.kind)(await memoryKeeper.handle(event));
          await bench.service?.activity(event);
        },
        benchIdle: async (ownerId) => (bench.service ? bench.service.idle(ownerId) : 'nothing'),
        post: async (ownerId, posted) => {
          const notice = postedNotice(posted);
          if (notice) await deps.notices.post(ownerId, { treeId: notice.refs.treeId, projectId: notice.refs.projectId }, notice);
        },
      },
    });
    void worker.run().catch((err: Error) =>
      console.warn(`[engine] stream worker stopped: ${err.message}`));
    console.log('[engine] stream worker polling engine-stream-queue');
  }, (message) => console.warn(message));
}
