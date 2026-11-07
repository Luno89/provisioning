import type { Client, WorkflowHandle } from '@temporalio/client'
import { WorkflowNotFoundError } from '@temporalio/common'
import type { Principal } from '../../../../backend/src/platform/lib/permissions'
import { authorize } from '../../../../backend/src/platform/lib/permissions'
import type { ProjectMetadata } from '../../../../backend/src/platform/lib/types'
import type { Site } from './site'
import { DATA_KEY, machinesOf, type Machines } from './machines'
import { outsideThisTier } from './outside'
import { projectsRouter } from '../../../../backend/src/projects/routes/projects'
import { projectChannelRouter } from '../../../../backend/src/projects/routes/project-channel'
import { itemChatsRouter } from '../../../../backend/src/projects/routes/item-chats'
import { treesRouter } from '../../../../backend/src/projects/routes/trees'
import { plansRouter } from '../../../../backend/src/projects/routes/plans'
import { branchesRouter } from '../../../../backend/src/projects/routes/branches'
import { leavesRouter } from '../../../../backend/src/projects/routes/leaves'
import { treeTypesRouter } from '../../../../backend/src/projects/routes/tree-types'
import { secretRequestsRouter } from '../../../../backend/src/projects/routes/secret-requests'
import { ProjectChannelService } from '../../../../backend/src/projects/services/ProjectChannelService'
import { ItemChatService } from '../../../../backend/src/projects/services/ItemChatService'
import { ProjectRemovalService } from '../../../../backend/src/projects/services/ProjectRemovalService'
import { GroveRunService } from '../../../../backend/src/projects/services/GroveRunService'
import { GroveDeletionService } from '../../../../backend/src/projects/services/GroveDeletionService'
import { GroveOrderService } from '../../../../backend/src/projects/services/GroveOrderService'
import { TreeHomeService } from '../../../../backend/src/projects/services/TreeHomeService'
import { PlanService } from '../../../../backend/src/projects/services/PlanService'
import { SecretRequestService } from '../../../../backend/src/projects/services/SecretRequestService'
import { ownNamespacesFrom } from '../../../../backend/src/projects/lib/tree-types'
import { groveAgentOf, resolveTreeType } from '../../../../backend/src/projects/lib/tree-types'
import { PROJECT_REMOVAL_PROGRESS_QUERY, type ProjectRemovalStep } from '../../../../backend/src/projects/lib/project-removal'
import { temporalRemovalWorkflows } from '../../../../backend/src/accounts/services/AccountRemovalService'
import { TreeModelsService, treeAgentsFrom } from '../../../../backend/src/models/services/TreeModelsService'
import { ModelService } from '../../../../backend/src/models/services/ModelService'
import { conversationsRouter } from '../../../../backend/src/engine/routes/conversations'
import { ConversationTurnService } from '../../../../backend/src/engine/services/ConversationTurnService'
import { extensionServiceFor } from '../../../../backend/src/engine/services/ExtensionService'
import { createRunStarter, type WorkflowStarter } from '../../../../backend/src/engine-host/registries/run-starter'
import { createStoredAgentRegistry } from '../../../../backend/src/engine-host/registries/registry'
import { directoryFromDatabase } from '../../../../backend/src/engine-host/registries/agent-directory'
import { conversationBinding } from '../../../../backend/src/engine-host/conversation-binding'
import { createGroveLauncher } from '../../../../backend/src/engine-host/grove-launcher'
import { accountDefaultOf } from '../../../../backend/src/machines/lib/machine-runs'
import { TemporalBridge } from '../../../../backend/src/infrastructure/services/TemporalBridge'
import { ClusterService } from '../../../../backend/src/infrastructure/services/ClusterService'
import type { InfrastructureService } from '../../../../backend/src/infrastructure/services/InfrastructureService'
import type { AppService } from '../../../../backend/src/infrastructure/services/AppService'
import type { GiteaService } from '../../../../backend/src/projects/services/GiteaService'
import type { ProjectRepoService } from '../../../../backend/src/projects/services/ProjectRepoService'
import { platformGroups } from '../../../../backend/src/extensions/installed'
import { treeTypeOfProject } from '../../../../backend/src/projects/lib/tree-types'
import { ODOO_TREE_TYPE } from '../../../../backend/src/projects/lib/tree-type-seeds'
import { releaseHowOf } from '../../../../backend/src/releases/lib/release-run'
import { CHART_FILE } from '../../../../backend/src/releases/lib/odoo-release'
import { latestBuildOf, projectMajor } from '../../../../backend/src/releases/lib/client-import'
import { OdooReleaseService } from '../../../../backend/src/releases/services/OdooReleaseService'
import { ReleaseSettings } from '../../../../backend/src/releases/services/ReleaseSettings'
import { ProjectAppService } from '../../../../backend/src/releases/services/ProjectAppService'
import { CustomizationsService } from '../../../../backend/src/releases/services/CustomizationsService'
import { ClientImportService } from '../../../../backend/src/releases/services/ClientImportService'
import { releaseSettingsRouter } from '../../../../backend/src/releases/routes/release-settings'
import { projectAppRouter } from '../../../../backend/src/releases/routes/project-app'
import { customizationsRouter } from '../../../../backend/src/releases/routes/customizations'
import { clientImportRouter } from '../../../../backend/src/releases/routes/client-import'
import { releasesRouter } from '../../../../backend/src/releases/routes/releases'
import { engineReleaseRuns } from '../../../../backend/src/engine-host/release-runs'
import { ODOO_RELEASE_ADAPTER } from '../../../../backend/src/extensions/odoo/release-adapter'
import type { SlotCluster } from '../../../../backend/src/extensions/releases/slot-cluster'
import { testClusterAccess } from '../../../../backend/src/infrastructure/testing/cluster-access'

export interface PaperWorkflow {
  workflowType: string
  workflowId: string
  args: unknown[]
  memo: Record<string, unknown>
  status: 'RUNNING' | 'CANCELLED'
  signals: { name: string; args: unknown[] }[]
}

export interface PaperTemporal {
  client: Client
  starter: WorkflowStarter
  workflows: Map<string, PaperWorkflow>
}

export function temporalOnPaper(): PaperTemporal {
  const workflows = new Map<string, PaperWorkflow>()
  const ends = new Map<string, (err: Error) => void>()
  const results = new Map<string, Promise<never>>()
  const begin = (workflowType: string, workflowId: string, args: unknown[], memo: Record<string, unknown>) => {
    workflows.set(workflowId, { workflowType, workflowId, args, memo, status: 'RUNNING', signals: [] })
    results.set(workflowId, new Promise<never>((_resolve, reject) => { ends.set(workflowId, reject) }))
  }
  const missing = (workflowId: string) => new WorkflowNotFoundError(`workflow ${workflowId} not found`, workflowId, undefined)
  const known = (workflowId: string): PaperWorkflow => {
    const found = workflows.get(workflowId)
    if (!found) throw missing(workflowId)
    return found
  }
  const handle = (workflowId: string) => ({
    workflowId,
    describe: async () => {
      const found = known(workflowId)
      return { workflowId, status: { name: found.status }, startTime: new Date('2026-11-06T00:00:00Z'), memo: found.memo }
    },
    signal: async (name: string, ...args: unknown[]) => { known(workflowId).signals.push({ name, args }) },
    query: async () => [],
    cancel: async () => {
      const found = known(workflowId)
      found.status = 'CANCELLED'
      const failed = new Error('cancelled')
      failed.name = 'WorkflowFailedError'
      ends.get(workflowId)?.(failed)
    },
    terminate: async () => undefined,
    result: () => results.get(workflowId) ?? Promise.reject(missing(workflowId)),
  }) as unknown as WorkflowHandle
  const workflow = {
    start: async (type: string | ((...args: never[]) => unknown), options: { workflowId: string; args?: unknown[]; memo?: Record<string, unknown> }) => {
      begin(typeof type === 'string' ? type : type.name, options.workflowId, options.args ?? [], options.memo ?? {})
      return handle(options.workflowId)
    },
    getHandle: (workflowId: string) => handle(workflowId),
  }
  const starter: WorkflowStarter = {
    start: async (workflowType, options) => {
      begin(workflowType, options.workflowId, options.args, options.memo)
      return { workflowId: options.workflowId }
    },
    signal: async (workflowId, name, payload) => { known(workflowId).signals.push({ name, args: payload === undefined ? [] : [payload] }) },
  }
  return { client: outsideThisTier<Client>('Temporal', { workflow: outsideThisTier<Client['workflow']>('Temporal workflow', workflow as unknown as Partial<Client['workflow']>) }), starter, workflows }
}

export interface ProjectsSide {
  machines: Machines
  temporal: PaperTemporal
  bridge: TemporalBridge
  clusters: ClusterService
  runs: ReturnType<typeof createRunStarter>
  registry: ReturnType<typeof createStoredAgentRegistry>
  agents: ReturnType<typeof directoryFromDatabase>
  channels: ProjectChannelService
  getOwnedProject: (id: string, principal: Principal) => Promise<ProjectMetadata | undefined>
}

export async function projectsOf(site: Site): Promise<ProjectsSide> {
  const { api, db } = site
  const machines = machinesOf(site)
  const temporal = temporalOnPaper()
  const host = outsideThisTier<InfrastructureService>('the host\'s k3d, kubectl and helm', { listLocalClusters: async () => [] })
  const clusters = new ClusterService(db, host, testClusterAccess(db, { dataKey: DATA_KEY }), { koalaMachineId: undefined })
  const bridge = new TemporalBridge(db, undefined, DATA_KEY, clusters, undefined, undefined, { connect: async () => temporal.client })
  await bridge.start()
  const gitea = outsideThisTier<GiteaService>('Gitea')
  const extensions = extensionServiceFor(db)
  const agents = directoryFromDatabase(db.engine, { hidden: (ownerId) => extensions.hidden(ownerId) })
  const registry = createStoredAgentRegistry({
    agents,
    procedures: { list: (ownerId) => db.engine.getProcedures(ownerId) },
    hidden: (ownerId) => extensions.hidden(ownerId),
    published: (ownerId) => extensions.groups(ownerId),
    accountDefault: async (ownerId) => accountDefaultOf(await db.accounts.getUserById(ownerId)),
  })
  const turns = new ConversationTurnService({ store: db.engine, log: db.engine, running: async () => true })
  const runs = createRunStarter({
    registry,
    turns,
    workflows: () => temporal.starter,
    binding: conversationBinding(db),
    closing: async (ownerId) => ((await db.accounts.getUserById(ownerId))?.removal ? 'it is being removed' : undefined),
    machines: (ownerId, choice) => machines.machines.choiceProblem(ownerId, choice),
  })
  const getOwnedProject = async (id: string, principal: Principal) => {
    const project = (await db.projects.getProjects()).find((p) => p.id === id)
    return project && authorize(principal, 'see', { kind: 'project', ownerId: project.ownerId }).allowed ? project : undefined
  }
  const channels = new ProjectChannelService({
    conversation: (ownerId, id) => db.engine.getConversation(ownerId, id),
    save: (conversation) => db.engine.saveConversation(conversation),
    bind: (ownerId, conversationId, binding) => db.engine.bindConversation(ownerId, conversationId, binding),
    trees: () => db.projects.getTrees(),
    saveProjectInfo: (project) => db.projects.saveProjectInfo(project),
  })
  const itemChats = new ItemChatService({
    leaves: () => db.projects.getLeaves(),
    branches: () => db.projects.getBranches(),
    trees: () => db.projects.getTrees(),
    conversation: (ownerId, id) => db.engine.getConversation(ownerId, id),
    save: (conversation) => db.engine.saveConversation(conversation),
  })
  const treeHome = new TreeHomeService({
    treeTypes: (ownerId) => db.projects.getTreeTypes(ownerId),
    projects: () => db.projects.getProjects(),
    createProject: () => { throw new Error('a tree that produces a service gets its project through Gitea, which the integration tier never reaches') },
    starter: async () => [],
    saveTree: (tree) => db.projects.saveTree(tree),
    secrets: { ensure: () => { throw new Error('a tree type\'s secrets go into Infisical, which the integration tier never reaches') } },
    channel: (project) => channels.ensure(project),
    saveNeeds: (project, needs) => db.projects.saveProjectInfo({ id: project.id, needs }),
  })
  const removal = new ProjectRemovalService({
    store: db,
    workflows: temporalRemovalWorkflows<{ projectId: string }, ProjectRemovalStep>(() => temporal.client, 'engine-ops-queue', PROJECT_REMOVAL_PROGRESS_QUERY),
  })
  const projectRepos = outsideThisTier<ProjectRepoService>('Gitea')
  api.use('/projects', projectsRouter({ db, projectRepoService: projectRepos, temporalBridge: bridge, getOwnedProject, giteaService: gitea, clusterService: clusters, removal, channels }))
  api.use('/items', itemChatsRouter({ items: itemChats }))
  api.use('/projects', projectChannelRouter({
    channels,
    conversations: async (ownerId) => (await db.engine.getConversations()).filter((conversation) => conversation.ownerId === ownerId),
    getOwnedProject,
  }))
  api.use('/conversations', conversationsRouter({
    db,
    ownedConversations: async (userId) => (await db.engine.getConversations()).filter((conversation) => conversation.ownerId === userId),
    ownedTrees: async (userId) => (await db.projects.getTrees()).filter((tree) => tree.ownerId === userId),
    ownedProjects: async (userId) => (await db.projects.getProjects()).filter((project) => project.ownerId === userId),
    workspaces: { conclude: async () => undefined },
    turns,
    binding: conversationBinding(db),
  }))
  const unreached = {} as never
  const models = new ModelService(db, { getAll: async () => [] } as unknown as AppService, unreached, unreached, unreached, DATA_KEY)
  const treeModels = new TreeModelsService({ store: db.projects, models, agentOf: treeAgentsFrom(registry), machines: (ownerId) => machines.machines.list(ownerId), groups: platformGroups })
  const groveRuns = new GroveRunService({
    store: db,
    launcher: createGroveLauncher({
      hidden: (ownerId) => extensions.hidden(ownerId),
      runs,
      client: () => temporal.client.workflow,
      agentFor: async (ownerId, treeId) => {
        const tree = (await db.projects.getTrees()).find((entry) => entry.id === treeId && entry.ownerId === ownerId)
        return groveAgentOf(await resolveTreeType(db.projects, ownerId, tree?.type))
      },
      leafRun: async (leafId) => (await db.projects.getLeaves()).find((leaf) => leaf.id === leafId)?.runId,
      modelFor: (ownerId, treeId, agentSlug) => treeModels.modelFor(ownerId, treeId, agentSlug),
      projectOf: async (ownerId, treeId) => (await db.projects.getTrees()).find((entry) => entry.id === treeId && entry.ownerId === ownerId)?.projectIds?.[0],
    }),
  })
  const treeWorkspaces = { state: async () => 'none' as const, release: async () => ({ saved: false as const, why: 'a tree with no sandbox has nothing to save', empty: true as const }) }
  const groveDeletion = new GroveDeletionService({ store: db, workflows: { stop: (workflowId, reason) => bridge.stopIfRunning(workflowId, reason) }, workspaces: treeWorkspaces })
  const groveOrder = new GroveOrderService({ store: db.projects })
  api.use('/trees', treesRouter({ db, order: groveOrder, home: treeHome, workspaces: treeWorkspaces, runs: groveRuns, models: treeModels, deletion: groveDeletion }))
  const plans = new PlanService({
    store: db.projects,
    adopter: bridge,
    stories: async (ownerId) => (await db.projects.getLeaves()).filter((leaf) => leaf.ownerId === ownerId).map((leaf) => ({ id: leaf.id, title: leaf.title, status: leaf.status })),
  })
  api.use('/plans', plansRouter({ plans }))
  api.use('/branches', branchesRouter({ db: db.projects, deletion: groveDeletion, order: groveOrder }))
  api.use('/leaves', leavesRouter({ db: db.projects, runs: groveRuns, deletion: groveDeletion }))
  api.use('/tree-types', treeTypesRouter({
    db,
    agents: async (ownerId) => (await registry.agents(ownerId)).map((agent) => agent.slug),
    ownNamespaces: ownNamespacesFrom(db.infrastructure),
  }))
  api.use('/secret-requests', secretRequestsRouter({ secrets: new SecretRequestService({ store: db.projects, vault: outsideThisTier('Infisical') }) }))
  return { machines, temporal, bridge, clusters, runs, registry, agents, channels, getOwnedProject }
}

export interface ReleasesSide {
  exposed: { deploymentId: string; mode: string }[]
}

export function releasesOf(site: Site, side: ProjectsSide): ReleasesSide {
  const { api, db } = site
  const gitea = outsideThisTier<GiteaService>('Gitea')
  const slots = outsideThisTier<SlotCluster>('the release slots on a cluster')
  const clusterById = (id: string) => side.clusters.getByIdUnscoped(id)
  const how = async (project: ProjectMetadata) => releaseHowOf(project, await treeTypeOfProject(db.projects, project), true)
  const exposed: ReleasesSide['exposed'] = []
  const releases = new OdooReleaseService({
    store: db,
    runs: engineReleaseRuns({ runs: side.runs, client: () => side.temporal.client.workflow }),
    how,
    chartAt: (owner, repo, commit) => gitea.getRawFile(owner, repo, CHART_FILE, commit).then((found) => found !== null),
    releaseWhen: async (project) => (await treeTypeOfProject(db.projects, project))?.releaseWhen,
    clusterById,
  })
  const settings = new ReleaseSettings({
    agents: async (ownerId) => (await side.agents.agents(ownerId)).map((agent) => ({ slug: agent.slug, name: agent.name, description: agent.description })),
    procedureOf: async (ownerId, slug) => (await side.registry.runnable(ownerId, slug))?.procedure,
    treeTypes: (ownerId) => db.projects.getTreeTypes(ownerId),
    saveTreeType: (type) => db.projects.saveTreeType(type),
    projects: () => db.projects.getProjects(),
    saveProject: (project) => db.projects.saveProject(project),
    typeOfProject: (project) => treeTypeOfProject(db.projects, project),
    hasChart: async (project) => Boolean(project.giteaOwner && project.giteaRepo && (await gitea.getRawFile(project.giteaOwner, project.giteaRepo, CHART_FILE, 'main')) !== null),
  })
  api.use('/release-settings', releaseSettingsRouter({ settings }))
  api.use('/projects', projectAppRouter({
    apps: new ProjectAppService({
      deployments: () => db.infrastructure.getDeployments(),
      expose: async (deploymentId, mode) => {
        exposed.push({ deploymentId, mode })
        await db.infrastructure.saveDeploymentInfo(mode === 'local' ? { id: deploymentId, localExposureUrl: `http://${deploymentId}.localhost` } : { id: deploymentId, publicExposureUrl: `https://${deploymentId}.koala.test` })
      },
    }),
    getOwnedProject: side.getOwnedProject,
  }))
  const customizations = new CustomizationsService({
    projects: () => db.projects.getProjects(),
    clusterById,
    how,
    cluster: slots,
    adapters: { [ODOO_RELEASE_ADAPTER.id]: ODOO_RELEASE_ADAPTER },
    trees: () => db.projects.getTrees(),
    branches: () => db.projects.getBranches(),
    leaves: () => db.projects.getLeaves(),
    tasks: (ownerId) => db.projects.getTasks(ownerId),
    savePlan: (proposal) => db.projects.savePlanProposal(proposal),
    treeTypeOf: async (project) => (await treeTypeOfProject(db.projects, project))?.id ?? ODOO_TREE_TYPE,
  })
  api.use('/projects', customizationsRouter({ customizations, getOwnedProject: side.getOwnedProject, channelOf: async (project) => (await side.channels.ensure(project))?.id }))
  const imports = new ClientImportService({
    projects: () => db.projects.getProjects(),
    saveProject: (patch) => db.projects.saveProjectInfo(patch),
    clusterById,
    adapterOf: async (project) => ((await how(project)).app === ODOO_RELEASE_ADAPTER.id ? ODOO_RELEASE_ADAPTER : undefined),
    cluster: slots,
    odooVersion: async (project) => {
      const tree = (await db.projects.getTrees()).find((entry) => entry.ownerId === project.ownerId && entry.projectIds?.[0] === project.id)
      return tree?.version ? projectMajor(tree.version) : undefined
    },
    latestBuild: async (project) => latestBuildOf(await db.releases.getPipelineRuns(), project.id),
    releases,
  })
  api.use('/projects', clientImportRouter({ imports, getOwnedProject: side.getOwnedProject }))
  api.use('/projects', releasesRouter({ releases, getOwnedProject: side.getOwnedProject, signIns: () => { throw new Error('a project\'s sign-ins are read from Infisical, which the integration tier never reaches') } }))
  return { exposed }
}
