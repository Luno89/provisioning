import { WorkflowExecutionAlreadyStartedError } from '@temporalio/common';
import type { Database, ProjectMetadata, Workflows } from '../../platform/index.js';
import { keepTrying, PLATFORM_OWNER, runOnce, startedFor, type ClusterMetadata, type Principal } from '../../platform/index.js';
import type { ClusterAccess } from '../../infrastructure/index.js';
import { ARCHIVE_MIGRATION } from '../lib/files-archive.js';
import { archiveOldFiles } from '../services/FilesArchive.js';
import { minioReachFrom } from '../services/MinioArtifactStore.js';
import type { GiteaService, ProjectRepoService } from '../../projects/index.js';
import { writeFileOnDevice } from '../../machines/index.js';
import { minioSettingsFrom } from '../lib/minio-settings.js';
import { STORED_FILES_SWEEP_ID, STORED_FILES_SWEEP_WORKFLOW, type StoredFilesActivities } from '../lib/stored-files-work.js';
import { ArtifactService } from '../services/ArtifactService.js';
import { FileService } from '../services/FileService.js';
import { minioBucketReader, minioObjectStore } from '../services/ObjectStore.js';
import { RepositoryDropService } from '../services/RepositoryDropService.js';
import { createStoredFilesActivities } from '../services/stored-files-activities.js';
import { temporalStoredFileCommits } from '../services/StoredFileCommits.js';
import { StoredFiles } from '../services/StoredFiles.js';
import { StoryDropService } from '../services/StoryDropService.js';
import { artifactsRouter } from '../routes/artifacts.js';
import { filesRouter, shareRouter } from '../routes/files.js';
import { projectFilesRouter } from '../routes/project-files.js';
import type { Mounts } from '../../hub/index.js';

export interface InstanceFiles {
  storedFiles: StoredFiles;
  activities: StoredFilesActivities;
  fileService: FileService;
  artifacts: ArtifactService;
}

export interface InstanceFilesDeps {
  db: Pick<Database, 'files'>;
  env: Readonly<Record<string, string | undefined>>;
  workflows: () => Promise<Pick<Workflows, 'start'>>;
  engineTaskQueue: string;
}

export function storedFilesFor(deps: InstanceFilesDeps): InstanceFiles {
  const objects = minioObjectStore(minioSettingsFrom(deps.env));
  const records = deps.db.files;
  const storedFiles = new StoredFiles({ records, objects, commits: temporalStoredFileCommits(deps.workflows, deps.engineTaskQueue) });
  return {
    storedFiles,
    activities: createStoredFilesActivities({ records, objects }),
    fileService: new FileService({ files: storedFiles, shares: records }),
    artifacts: new ArtifactService({ files: storedFiles }),
  };
}

export interface ArchiveDeps {
  db: Pick<Database, 'files' | 'infrastructure' | 'platform'>;
  storedFiles: StoredFiles;
  clusters: { access: Pick<ClusterAccess, 'reach' | 'kubectl'>; getByIdUnscoped: (id: string) => Promise<ClusterMetadata | undefined> };
}

export function archiveOldFilesOnce(deps: ArchiveDeps): void {
  void keepTrying('[files] what people kept on their own MinIO apps before is not in their Archive yet', async () => {
    const done = await runOnce(deps.db.platform, ARCHIVE_MIGRATION, new Date().toISOString(), async () => {
      const reach = minioReachFrom({ deployments: () => deps.db.infrastructure.getDeployments(), access: deps.clusters.access, clusterById: deps.clusters.getByIdUnscoped });
      const archived = await archiveOldFiles({
        files: deps.storedFiles,
        servers: async () => Promise.all((await deps.db.infrastructure.getDeployments())
          .filter((deployment) => deployment.appType === 'minio' && deployment.ownerId && !['destroying', 'destroyed', 'failed'].includes(deployment.status))
          .map(async (deployment) => {
            if (!deployment.minioRootUser || !deployment.minioRootPassword) throw new Error(`the MinIO app ${deployment.name} of ${deployment.ownerId} has no stored keys, so its files cannot be read for the Archive`);
            const at = await reach.endpoint(deployment);
            return { ownerId: deployment.ownerId!, appName: deployment.name, reader: minioBucketReader({ endPoint: at.host, port: at.port, useSSL: false, accessKey: deployment.minioRootUser, secretKey: deployment.minioRootPassword }) };
          })),
        oldArtifacts: () => deps.db.files.oldArtifacts(),
        forgetOldArtifacts: () => deps.db.files.forgetOldArtifacts(),
      });
      return { ...archived };
    });
    console.log(`[files] the Archive holds what was kept before: ${JSON.stringify(done)}`);
  }, (message) => console.warn(message));
}

export function keepStoredFilesSwept(deps: Pick<InstanceFilesDeps, 'workflows' | 'engineTaskQueue'>): void {
  void keepTrying('[files] the daily sweep of stored files has not started yet', async () => {
    try {
      await (await deps.workflows()).start(STORED_FILES_SWEEP_WORKFLOW, {
        workflowId: STORED_FILES_SWEEP_ID,
        taskQueue: deps.engineTaskQueue,
        args: [],
        ...startedFor(PLATFORM_OWNER),
      });
    } catch (error) {
      if (error instanceof WorkflowExecutionAlreadyStartedError) return;
      const { message, cause } = error as Error & { cause?: unknown };
      throw new Error(cause instanceof Error ? `${message}: ${cause.message}` : message);
    }
  }, (message) => console.warn(message));
}

export interface FilesWiringDeps {
  tenant: Mounts;
  db: Database;
  files: InstanceFiles;
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
  const { fileService } = deps.files;
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
  tenant.use('/api/files', filesRouter({
    files: fileService,
    getOwnedProject: deps.getOwnedProject,
    getOwnedConversation: async (ownerId, id) => {
      const conversation = await db.engine.getConversation(ownerId, id);
      return conversation ? { id: conversation.id, ...(conversation.projectId ? { projectId: conversation.projectId } : {}) } : undefined;
    },
  }));
  tenant.use('/api/share', shareRouter({ files: fileService }));
  tenant.use('/api/artifacts', artifactsRouter({ artifacts: deps.files.artifacts }));
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
