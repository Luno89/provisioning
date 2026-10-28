import type { Database, ProjectMetadata } from '../../platform/index.js';
import { type Principal } from '../../platform/index.js';
import { DEFAULT_TARGET_CLUSTER, type GiteaService, type ProjectRepoService } from '../../projects/index.js';
import { writeFileOnDevice } from '../../machines/index.js';
import { FileStores } from '../services/FileStores.js';
import { FileService } from '../services/FileService.js';
import { RepositoryDropService } from '../services/RepositoryDropService.js';
import { StoryDropService } from '../services/StoryDropService.js';
import type { createArtifactService } from '../services/artifact-service-factory.js';
import type { TemporalBridge } from '../../infrastructure/index.js';
import { filesRouter, shareRouter } from '../routes/files.js';
import { projectFilesRouter } from '../routes/project-files.js';
import type { Mounts } from '../../hub/index.js';

export interface FilesWiringDeps {
  tenant: Mounts;
  db: Database;
  reach: ReturnType<typeof createArtifactService>['reach'];
  temporalBridge: Pick<TemporalBridge, 'deployApp'>;
  projectRepos: ProjectRepoService;
  gitea: GiteaService;
  getOwnedProject: (id: string, principal: Principal) => Promise<ProjectMetadata | undefined>;
}

export interface FilesWiring {
  fileService: FileService;
  repositoryDrops: RepositoryDropService;
  setStoryDrops(drops: StoryDropService): void;
}

export function wireFiles(deps: FilesWiringDeps): FilesWiring {
  const { db, tenant, gitea, projectRepos } = deps;
  const fileStores = new FileStores(deps.reach);
  const fileService = new FileService({
    store: db,
    open: (ownerId, place) => fileStores.open(ownerId, place),
    deployMinio: async (ownerId, request) => {
      const started = await deps.temporalBridge.deployApp({ ...request, appType: 'minio', strategy: 'native' }, ownerId);
      if (!started.resourceId) throw new Error(`MinIO could not be started on ${request.clusterId}.`);
      return { deploymentId: started.resourceId };
    },
    defaultCluster: DEFAULT_TARGET_CLUSTER,
  });
  const repositoryDrops = new RepositoryDropService({
    credential: (ownerId) => projectRepos.editorCredential(ownerId),
    commit: (credential, owner, repo, files, message, branch) => gitea.commitDropFromDisk(credential, owner, repo, files, message, branch),
    writeOnDevice: (deviceId, ownerId, leafId, target, bytes) => writeFileOnDevice(deviceId, ownerId, leafId, target, bytes),
  });
  let storyDrops: StoryDropService | undefined;
  tenant.use('/api/projects', projectFilesRouter({
    projectRepoService: projectRepos,
    giteaService: gitea,
    getOwnedProject: deps.getOwnedProject,
    drops: repositoryDrops,
    storyDrops: { drop: (...args: Parameters<StoryDropService['drop']>) => {
      if (!storyDrops) throw new Error('stories cannot take dropped code here');
      return storyDrops.drop(...args);
    } },
  }));
  tenant.use('/api/files', filesRouter({ files: fileService, getOwnedProject: deps.getOwnedProject }));
  tenant.use('/api/share', shareRouter({ files: fileService }));
  return { fileService, repositoryDrops, setStoryDrops: (drops) => { storyDrops = drops; } };
}

export function storyDropsFor(deps: { db: Database; projectRepos: ProjectRepoService; gitea: GiteaService; work: ConstructorParameters<typeof StoryDropService>[0]['work'] }): StoryDropService {
  const { db } = deps;
  return new StoryDropService({
    leaves: { list: () => db.projects.getLeaves(), save: (leaf) => db.projects.saveLeaf(leaf) },
    treeOfLeaf: async (leaf) => {
      const branch = (await db.projects.getBranches()).find((entry) => entry.id === leaf.branchId);
      return branch ? (await db.projects.getTrees()).find((tree) => tree.id === branch.treeId) : undefined;
    },
    account: (ownerId) => deps.projectRepos.ensureAccountFor(ownerId),
    credential: (ownerId) => deps.projectRepos.editorCredential(ownerId),
    commit: (credential, owner, repo, files, message, branch, newBranch) => deps.gitea.commitDropFromDisk(credential, owner, repo, files, message, branch, newBranch),
    work: deps.work,
  });
}
