import type { PersonaRecord } from '@koala/agent-engine'
import type { Site } from './site'
import { DATA_KEY } from './machines'
import { outsideThisTier } from './outside'
import { standInMemoryIndex } from './memory-index'
import { ownedBy } from '../../../../backend/src/platform/lib/ownership'
import { decryptValue } from '../../../../backend/src/platform/lib/crypto'
import { extensionServiceFor } from '../../../../backend/src/engine/services/ExtensionService'
import { EngineToolService } from '../../../../backend/src/engine/services/EngineToolService'
import { AgentService } from '../../../../backend/src/engine/services/AgentService'
import { ProcedureService } from '../../../../backend/src/engine/services/ProcedureService'
import { AutoModeService } from '../../../../backend/src/engine/services/AutoModeService'
import { ApprovalService } from '../../../../backend/src/engine/services/ApprovalService'
import { McpServerService } from '../../../../backend/src/engine/services/McpServerService'
import { McpService } from '../../../../backend/src/engine/services/McpService'
import { WorkspaceDependencyService } from '../../../../backend/src/engine/services/WorkspaceDependencyService'
import { PoisoningService } from '../../../../backend/src/engine/services/PoisoningService'
import { DocumentService } from '../../../../backend/src/engine/services/DocumentService'
import { ActionService } from '../../../../backend/src/engine/services/ActionService'
import { ConversationTurnService } from '../../../../backend/src/engine/services/ConversationTurnService'
import { PracticeService } from '../../../../backend/src/memory/services/PracticeService'
import { memoriesRouter } from '../../../../backend/src/memory/routes/memories'
import { agentsRouter } from '../../../../backend/src/engine/routes/agents'
import { engineToolsRouter } from '../../../../backend/src/engine/routes/engine-tools'
import { proceduresRouter } from '../../../../backend/src/engine/routes/procedures'
import { autoModeRouter } from '../../../../backend/src/engine/routes/auto-mode'
import { workspaceDependenciesRouter } from '../../../../backend/src/engine/routes/workspace-dependencies'
import { mcpRouter } from '../../../../backend/src/engine/routes/mcp'
import { poisoningRouter } from '../../../../backend/src/engine/routes/poisoning'
import { turnsRouter } from '../../../../backend/src/engine/routes/turns'
import { documentsRouter } from '../../../../backend/src/engine/routes/documents'
import { actionsRouter } from '../../../../backend/src/engine/routes/actions'
import { engineRouter } from '../../../../backend/src/engine/routes/engine'
import { pendingApprovalsRouter } from '../../../../backend/src/infrastructure/routes/pending-approvals'
import { treeTypeChoices } from '../../../../backend/src/projects/lib/tree-types'
import { createRunStarter, type WorkflowStarter } from '../../../../backend/src/engine-host/registries/run-starter'
import { createStoredAgentRegistry } from '../../../../backend/src/engine-host/registries/registry'
import { directoryFromDatabase } from '../../../../backend/src/engine-host/registries/agent-directory'
import { createStoredToolCatalogue } from '../../../../backend/src/engine-host/registries/tool-catalogue-store'
import { createProcedureStore } from '../../../../backend/src/engine-host/registries/procedure-store'
import { createWorkspaceRepoResolver } from '../../../../backend/src/engine-host/sandboxes/workspace-repos'
import { conversationBinding } from '../../../../backend/src/engine-host/conversation-binding'
import { MCP_SERVER_TEMPLATES } from '../../../../backend/src/extensions/mcp/templates'
import type { TemporalBridge } from '../../../../backend/src/infrastructure/services/TemporalBridge'
import type { ProjectRepoService } from '../../../../backend/src/projects/services/ProjectRepoService'

export interface StartedEngineWorkflow {
  workflowType: string
  workflowId: string
  taskQueue: string
  args: unknown[]
  owner: string
  memo: Record<string, unknown>
}

export interface EngineSite {
  started: StartedEngineWorkflow[]
}

export function mountEngine({ api, db }: Site): EngineSite {
  const started: StartedEngineWorkflow[] = []
  const unindex = standInMemoryIndex()
  const extensions = extensionServiceFor(db)
  const agentDirectory = directoryFromDatabase(db.engine, { hidden: (ownerId) => extensions.hidden(ownerId) })
  const registry = createStoredAgentRegistry({
    agents: agentDirectory,
    procedures: { list: (ownerId) => db.engine.getProcedures(ownerId) },
    hidden: (ownerId) => extensions.hidden(ownerId),
    published: (ownerId) => extensions.groups(ownerId),
  })
  const draftCatalogue = createStoredToolCatalogue({ tools: { list: (ownerId) => db.engine.getEngineTools(ownerId) } })
  const workspaceDependencies = new WorkspaceDependencyService({
    store: db.engine,
    tools: (ownerId) => db.engine.getEngineTools(ownerId),
    servers: (ownerId) => db.engine.getMcpServers(ownerId),
    workspaces: async (ownerId) => {
      const [published, trees] = await Promise.all([db.engine.getPublishedWorkspaces(ownerId), db.projects.getTrees()])
      const names = new Map(trees.filter((tree) => tree.ownerId === ownerId).map((tree) => [tree.id, tree.name]))
      return published.map((workspace) => ({ ...workspace, treeName: names.get(workspace.treeId) }))
    },
  })
  const dependenciesOf = (ownerId: string) => workspaceDependencies.catalogue(ownerId)
  const workflows: WorkflowStarter = {
    start: async (workflowType, options) => {
      started.push({ workflowType, ...options })
      return { workflowId: options.workflowId }
    },
    signal: async () => undefined,
  }
  const turns = new ConversationTurnService({ store: db.engine, log: db.engine, running: async () => true })
  const runs = createRunStarter({ registry, turns, workflows: () => workflows, binding: conversationBinding(db) })
  const autoMode = new AutoModeService({ store: db, agentExists: async (ownerId, slug) => Boolean(await registry.agent(ownerId, slug)) })
  const toolNotes = new PracticeService({ store: db.memory, unindex, category: 'tool_note' })
  const ownedTrees = async (userId: string) => ownedBy(await db.projects.getTrees(), userId)
  const ownedConversations = async (userId: string) => (await db.engine.getConversations()).filter((conversation) => conversation.ownerId === userId)
  const agents = new AgentService({
    agents: agentDirectory,
    records: {
      save: (record: PersonaRecord) => db.engine.saveEnginePersona(record),
      remove: (ownerId, slug) => db.engine.deleteEnginePersona(ownerId, slug),
    },
    tools: (ownerId) => draftCatalogue.list(ownerId),
    procedures: (ownerId) => registry.procedures(ownerId),
    treeTypes: async (ownerId) => treeTypeChoices(await db.projects.getTreeTypes(ownerId), ownerId),
    servers: (ownerId) => db.engine.getMcpServers(ownerId),
    dependencies: dependenciesOf,
  })
  const mcpCatalogue = new McpServerService({
    dependencies: dependenciesOf,
    store: { list: (ownerId) => db.engine.getMcpServers(ownerId), save: (server) => db.engine.saveMcpServer(server), remove: (ownerId, id) => db.engine.deleteMcpServer(ownerId, id) },
    templates: () => MCP_SERVER_TEMPLATES,
    projects: async (ownerId) => (await db.projects.getProjects()).filter((project) => project.ownerId === ownerId),
    runs,
    finished: async (runId) => db.engine.findRunEffort(runId),
    deployments: () => db.infrastructure.getDeployments(),
    grants: agentDirectory,
    notes: toolNotes,
    names: async () => ({}),
  })

  api.use('/engine', engineRouter({
    runs,
    registry,
    approvals: new ApprovalService({ store: db.engine, runs, autoMode }),
    traces: { list: (ownerId, runId) => db.engine.getRunTraces(ownerId, runId) },
    tasks: { list: (ownerId) => db.projects.getTasks(ownerId), save: (task) => db.projects.saveTask(task) },
    extensions,
  }))
  api.use('/procedures', proceduresRouter({
    procedures: new ProcedureService({
      hidden: (ownerId) => extensions.hidden(ownerId),
      published: (ownerId) => extensions.groups(ownerId),
      procedures: createProcedureStore({ sources: { list: (ownerId) => db.engine.getProcedures(ownerId) }, published: (ownerId) => extensions.groups(ownerId) }),
      sources: {
        get: (ownerId, id) => db.engine.getProcedure(ownerId, id),
        save: (source) => db.engine.saveProcedure(source),
        delete: (ownerId, id) => db.engine.deleteProcedure(ownerId, id),
      },
      known: async (ownerId) => ({
        tools: await (async () => {
          const hidden = await extensions.hidden(ownerId)
          return new Set((await draftCatalogue.names(ownerId)).filter((name) => !hidden.tools.has(name)))
        })(),
        agents: new Set((await registry.agents(ownerId)).map((agent) => agent.slug)),
      }),
      effort: { list: (ownerId, procedureId) => db.engine.getRunEffort(ownerId, procedureId) },
    }),
  }))
  api.use('/engine-tools', engineToolsRouter({
    tools: new EngineToolService({
      catalogue: draftCatalogue,
      dependencies: dependenciesOf,
      tools: {
        list: (ownerId) => db.engine.getEngineTools(ownerId),
        save: (tool) => db.engine.saveEngineTool(tool),
        remove: (ownerId, name) => db.engine.deleteEngineTool(ownerId, name),
      },
      agents: agentDirectory,
      servers: (ownerId) => db.engine.getMcpServers(ownerId),
      implemented: new Set<string>(),
    }),
  }))
  api.use('/agents', agentsRouter({ agents }))
  api.use('/auto-mode', autoModeRouter({ autoMode }))
  api.use('/workspace-dependencies', workspaceDependenciesRouter({ dependencies: workspaceDependencies }))
  api.use('/mcp', mcpRouter({ mcp: new McpService({ store: db.engine, catalogue: (ownerId) => db.engine.getMcpServers(ownerId) }), catalogue: mcpCatalogue }))
  api.use('/poisoning', poisoningRouter({
    poisoning: new PoisoningService({
      store: db.engine,
      memories: { list: (ownerId) => db.memory.getMemories(ownerId), save: (item) => db.memory.saveMemory(item), unindex },
      unseal: (sealed) => decryptValue(sealed, DATA_KEY),
    }),
  }))
  api.use('/turns', turnsRouter({ log: { read: (ownerId, turnId, after) => db.engine.getTurnLog(ownerId, turnId, after), recent: (ownerId, since, limit) => db.engine.recentTurns(ownerId, since, limit) } }))
  api.use('/documents', documentsRouter({
    documents: new DocumentService({
      repoFor: createWorkspaceRepoResolver({ trees: () => db.projects.getTrees(), projects: () => db.projects.getProjects(), accountOf: async (ownerId) => (await db.projects.getGiteaAccount(ownerId))?.username }),
      owns: async (userId, kind, id) => (kind === 'tree'
        ? (await ownedTrees(userId)).some((tree) => tree.id === id)
        : (await ownedConversations(userId)).some((conversation) => conversation.id === id)),
      read: (userId, repo, path, ref) => outsideThisTier<ProjectRepoService>('Gitea').readDocument(userId, repo, path, ref),
    }),
  }))
  api.use('/actions', actionsRouter({
    actions: new ActionService({
      store: db,
      deployer: outsideThisTier<TemporalBridge>('the Temporal bridge'),
      servers: { add: (ownerId, input) => mcpCatalogue.add(ownerId, input), list: (ownerId) => db.engine.getMcpServers(ownerId) },
      dependencies: workspaceDependencies,
      agents: {
        agents: (ownerId) => agentDirectory.agents(ownerId),
        holdServer: (ownerId, slug, server, meta) => agents.holdServer(ownerId, slug, server, meta),
        image: (ownerId, slug) => agents.image(ownerId, slug),
      },
    }),
  }))
  api.use('/pending-approvals', pendingApprovalsRouter({ db }))
  api.use('/memories', memoriesRouter({ db, temporalBridge: {}, unindex }))
  return { started }
}
