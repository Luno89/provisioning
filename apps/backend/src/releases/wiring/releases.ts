import type { Server as SocketServer } from 'socket.io';
import { type Database, type ProjectMetadata, awaitedNotice, releaseNotice } from '../../platform/index.js';
import { treeTypeOfProject } from '../../projects/lib/tree-types.js';
import { ODOO_TREE_TYPE } from '../../projects/lib/tree-type-seeds.js';
import { latestBuildOf, odooVersionOfDockerfile, projectMajor } from '../lib/client-import.js';
import { buildPlanAt } from '../lib/build-plan.js';
import { changedPaths, releaseDecision, type ReleaseDecision } from '../lib/release-paths.js';
import { releaseHowOf } from '../lib/release-run.js';
import { deploymentForProject } from '../../projects/lib/project-status.js';
import { CHART_FILE, ODOO_RELEASE_SECRETS, OWN_SECRET_FILE, releaseTargetOf } from '../lib/odoo-release.js';
import { createSlotCluster } from '../../extensions/releases/slot-cluster.js';
import { syncVaultFromProject } from '../../extensions/releases/vault-sync.js';
import { ODOO_RELEASE_ADAPTER } from '../../extensions/odoo/release-adapter.js';
import { engineReleaseRuns } from '../../engine-host/release-runs.js';
import type { RunStarter } from '../../engine-host/registries/run-starter.js';
import type { createStoredAgentRegistry, directoryFromDatabase } from '../../engine-host/index.js';
import { OdooReleaseService } from '../services/OdooReleaseService.js';
import { ImageReleases } from '../services/ImageReleases.js';
import { ReleaseSettings } from '../services/ReleaseSettings.js';
import { CustomizationsService } from '../services/CustomizationsService.js';
import { ClientImportService } from '../services/ClientImportService.js';
import { ProjectAppService } from '../services/ProjectAppService.js';
import type { projectSecretsFor } from '../../projects/services/ProjectSecretsService.js';
import type { TemporalBridge, AppExposureService, ClusterService, InfrastructureService } from '../../infrastructure/index.js';
import type { ConversationNoticeService } from '../../engine/services/ConversationNoticeService.js';
import type { ProjectChannelService } from '../../projects/services/ProjectChannelService.js';
import type { ProjectRepoService } from '../../projects/services/ProjectRepoService.js';
import type { GiteaService } from '../../projects/services/GiteaService.js';
import { releaseSettingsRouter } from '../routes/release-settings.js';
import { projectAppRouter } from '../routes/project-app.js';
import { customizationsRouter } from '../routes/customizations.js';
import { clientImportRouter } from '../routes/client-import.js';
import { releasesRouter } from '../routes/releases.js';
import type { Mounts } from '../../hub/wiring/hub.js';

export interface ReleasesWiringDeps {
  tenant: Mounts;
  db: Database;
  io: Pick<SocketServer, 'to'>;
  gitea: GiteaService;
  infra: InfrastructureService;
  clusters: ClusterService;
  projectRepos: ProjectRepoService;
  temporalBridge: TemporalBridge;
  runs: RunStarter;
  notices: ConversationNoticeService;
  postNotice: (what: string, posting: Promise<unknown>) => void;
  secrets: ReturnType<typeof projectSecretsFor>;
  agents: ReturnType<typeof directoryFromDatabase>;
  registry: ReturnType<typeof createStoredAgentRegistry>;
  exposure: AppExposureService;
  channels: ProjectChannelService;
  getOwnedProject: (id: string, user: unknown) => Promise<ProjectMetadata | undefined>;
}

export interface ReleasesWiring {
  odooReleases: OdooReleaseService;
  releaseSettings: ReleaseSettings;
  imageReleases: ImageReleases;
  customizations: CustomizationsService;
  clientImports: ClientImportService;
  letReleasesPull: () => Promise<number>;
}

export function wireReleases(deps: ReleasesWiringDeps): ReleasesWiring {
  const { db, gitea, infra, clusters, temporalBridge, notices, postNotice, secrets, tenant } = deps;
  const treeOfProject = async (projectId: string) => (await db.projects.getTrees()).find((tree) => tree.projectIds?.[0] === projectId);
  const clusterById = async (id: string) => (id === 'provisioning-lunorica' ? clusters.getSystemClusterEntry() : (await db.infrastructure.getClusters()).find((cluster) => cluster.id === id));
  const slotCluster = () => createSlotCluster({ infra, repo: async () => gitea, registry: () => gitea.registryLogin(), syncVault: syncVaultFromProject(infra) });

  const decideRelease = async (project: ProjectMetadata, since: string, commit: string): Promise<ReleaseDecision> => {
    const releaseWhen = (await treeTypeOfProject(db.projects, project))?.releaseWhen;
    if (!releaseWhen?.length || !project.giteaOwner || !project.giteaRepo) return { release: true };
    try {
      const [before, after] = await Promise.all([gitea.fileHashes(project.giteaOwner, project.giteaRepo, since), gitea.fileHashes(project.giteaOwner, project.giteaRepo, commit)]);
      return releaseDecision(changedPaths(before, after), releaseWhen, since);
    } catch (err) {
      console.warn(`[releases] ${project.name}: what changed since ${since.slice(0, 8)} could not be read, so the build is released: ${(err as Error).message}`);
      return { release: true };
    }
  };
  temporalBridge.decideRelease = decideRelease;

  const customizations = new CustomizationsService({
    projects: () => db.projects.getProjects(),
    clusterById,
    how: async (project) => releaseHowOf(project, await treeTypeOfProject(db.projects, project), true),
    cluster: slotCluster(),
    adapters: { [ODOO_RELEASE_ADAPTER.id]: ODOO_RELEASE_ADAPTER },
    trees: () => db.projects.getTrees(),
    branches: () => db.projects.getBranches(),
    leaves: () => db.projects.getLeaves(),
    tasks: (ownerId) => db.projects.getTasks(ownerId),
    savePlan: (proposal) => db.projects.savePlanProposal(proposal),
    treeTypeOf: async (project) => (await treeTypeOfProject(db.projects, project))?.id ?? ODOO_TREE_TYPE,
  });

  const odooReleases = new OdooReleaseService({
    store: db,
    decide: decideRelease,
    runs: engineReleaseRuns({ runs: deps.runs, client: () => (temporalBridge.isReady() ? temporalBridge.client.workflow : undefined) }),
    how: async (project) => releaseHowOf(project, await treeTypeOfProject(db.projects, project), true),
    chartAt: async (owner, repo, commit) => (await gitea.getRawFile(owner, repo, CHART_FILE, commit)) !== null,
    diff: (project, base, head) => deps.projectRepos.diffCommits({ ownerId: project.ownerId!, owner: project.giteaOwner!, repo: project.giteaRepo!, base, head }),
    releaseWhen: async (project) => (await treeTypeOfProject(db.projects, project))?.releaseWhen,
    clusterById,
    awaiting: (ownerId, project, run) => {
      postNotice('a project waits for its client\'s database', treeOfProject(project.id).then((tree) => notices.post(ownerId, { projectId: project.id, treeId: tree?.id }, awaitedNotice(project, run.commitSha, tree?.id))));
    },
    notify: (ownerId, release) => {
      deps.io.to(`user:${ownerId}`).emit('odoo-release-updated', release);
      postNotice('a release changed', treeOfProject(release.projectId).then(async (tree) => {
        const made = release.restore && release.state === 'live' ? await customizations.drift(ownerId, release.projectId).then((drift) => (drift.ok ? drift.value.items.length : undefined), () => undefined) : undefined;
        const notice = releaseNotice(release, tree?.id, made);
        return notice ? notices.post(ownerId, { projectId: release.projectId, treeId: tree?.id }, notice) : [];
      }));
    },
    secrets: {
      ensure: (project, options) => secrets.ensure(project, options),
      keep: (projectId, key, value) => secrets.keep(projectId, key, value),
      chartKeepsOwnSecret: async (owner, repo, commit) => (await gitea.getRawFile(owner, repo, OWN_SECRET_FILE, commit)) !== null,
      onCluster: async (cluster, namespace, secret, key) => {
        const data = await infra.runKubectl(['get', 'secret', secret, '-n', namespace, '-o', 'jsonpath={.data}'], await clusters.getKubeconfigPath(cluster)).catch(() => '');
        const encoded = data ? (JSON.parse(data) as Record<string, string>)[key] : undefined;
        return encoded ? Buffer.from(encoded, 'base64').toString('utf8') : undefined;
      },
    },
  });
  temporalBridge.ensureSecrets = (project) => secrets.ensure(project, {});
  temporalBridge.planBuild = (project, commitSha) => buildPlanAt((file) => gitea.getRawFile(project.giteaOwner!, project.giteaRepo!, file, commitSha).catch(() => null), commitSha);

  const releaseSettings = new ReleaseSettings({
    agents: async (ownerId) => (await deps.agents.agents(ownerId)).map((agent) => ({ slug: agent.slug, name: agent.name, description: agent.description })),
    procedureOf: async (ownerId, slug) => (await deps.registry.runnable(ownerId, slug))?.procedure,
    treeTypes: (ownerId) => db.projects.getTreeTypes(ownerId),
    saveTreeType: (type) => db.projects.saveTreeType(type),
    projects: () => db.projects.getProjects(),
    saveProject: (project) => db.projects.saveProject(project),
    typeOfProject: (project) => treeTypeOfProject(db.projects, project),
    hasChart: async (project) => Boolean(project.giteaOwner && project.giteaRepo && (await gitea.getRawFile(project.giteaOwner, project.giteaRepo, CHART_FILE, 'main')) !== null),
  });
  tenant.use('/api/release-settings', releaseSettingsRouter({ settings: releaseSettings }));

  const imageReleases = new ImageReleases({
    runs: deps.runs,
    deployedTag: async (project) => deploymentForProject(project, await db.infrastructure.getDeployments())?.gitappImageTag?.split(':').pop(),
    decide: decideRelease,
    ensureSecrets: (project) => secrets.ensure(project, {}),
    noteOnBuild: (run) => db.releases.savePipelineRunInfo(run),
  });
  temporalBridge.onBuilt = async (project, run) => {
    const how = releaseHowOf(project, await treeTypeOfProject(db.projects, project), await odooReleases.releasesByChart(project, run.commitSha));
    if (!how.app) {
      const outcome = await imageReleases.release(project, run, how.agent);
      if (typeof outcome === 'object') console.log(`[releases] ${project.name}: the build of ${run.commitSha.slice(0, 8)} was not deployed: ${'skipped' in outcome ? outcome.skipped : outcome.refused}`);
      return true;
    }
    const started = await odooReleases.release(project, run);
    if ('error' in started) console.error(`[releases] ${project.name}: the build of ${run.commitSha} was not released: ${started.error}`);
    if ('skipped' in started) console.log(`[releases] ${project.name}: the build of ${run.commitSha.slice(0, 8)} has nothing to release: ${started.skipped}`);
    return true;
  };

  tenant.use('/api/projects', projectAppRouter({
    apps: new ProjectAppService({
      deployments: () => db.infrastructure.getDeployments(),
      expose: (deploymentId, mode) => (mode === 'local' ? deps.exposure.exposeLocal(deploymentId) : deps.exposure.exposePublic(deploymentId)),
    }),
    getOwnedProject: deps.getOwnedProject,
  }));
  tenant.use('/api/projects', customizationsRouter({ customizations, getOwnedProject: deps.getOwnedProject, channelOf: async (project) => (await deps.channels.ensure(project))?.id }));

  const clientImports = new ClientImportService({
    projects: () => db.projects.getProjects(),
    saveProject: (patch) => db.projects.saveProjectInfo(patch),
    clusterById,
    adapterOf: async (project) => {
      const how = await releaseHowOf(project, await treeTypeOfProject(db.projects, project), true);
      return how.app === ODOO_RELEASE_ADAPTER.id ? ODOO_RELEASE_ADAPTER : undefined;
    },
    cluster: slotCluster(),
    odooVersion: async (project) => {
      const tree = (await db.projects.getTrees()).find((entry) => entry.ownerId === project.ownerId && entry.projectIds?.[0] === project.id);
      if (tree?.version) return projectMajor(tree.version);
      const declared = project.giteaOwner && project.giteaRepo ? odooVersionOfDockerfile(await gitea.getRawFile(project.giteaOwner, project.giteaRepo, 'Dockerfile', 'main').catch(() => null)) : undefined;
      if (declared) return declared;
      const type = await treeTypeOfProject(db.projects, project) ?? (await db.projects.getTreeTypes(project.ownerId)).find((entry) => entry.id === ODOO_TREE_TYPE);
      return type?.versions?.default ? projectMajor(type.versions.default) : undefined;
    },
    latestBuild: async (project) => latestBuildOf(await db.releases.getPipelineRuns(), project.id),
    releases: odooReleases,
  });
  tenant.use('/api/projects', clientImportRouter({ imports: clientImports, getOwnedProject: deps.getOwnedProject }));
  tenant.use('/api/projects', releasesRouter({ releases: odooReleases, getOwnedProject: deps.getOwnedProject, signIns: (project) => secrets.signIns(project, ODOO_RELEASE_SECRETS) }));

  const letReleasesPull = async (): Promise<number> => {
    const slots = slotCluster();
    let ready = 0;
    for (const project of await db.projects.getProjects()) {
      if (!project.ownerId || !project.targetClusterId) continue;
      if (!(await db.releases.getOdooReleases(project.ownerId, project.id)).length) continue;
      const cluster = await clusterById(project.targetClusterId);
      if (!cluster) continue;
      try {
        await slots.pullAccess(releaseTargetOf(cluster, project));
        ready += 1;
      } catch (err) {
        console.warn(`[releases] ${project.name}'s namespace could not be given its registry login: ${(err as Error).message}`);
      }
    }
    return ready;
  };

  return { odooReleases, releaseSettings, imageReleases, customizations, clientImports, letReleasesPull };
}
