import { Router, type Request } from 'express';
import crypto from 'crypto';
import path from 'path';
import { asyncRoute, at, type Principal, principalFrom, type ProjectMetadata } from '../../platform/index.js';
import { isSafeRepoDir, isSafeRepoFilePath } from '../lib/project-file-paths.js';
import { DROP_TYPE } from '../lib/drops.js';
import { withReceivedDrop } from '../services/drop-receiver.js';
import { GiteaConflictError, type GiteaService, type ProjectRepoService } from '../../projects/index.js';
import type { RepositoryDropService } from '../services/RepositoryDropService.js';
import type { StoryDropService } from '../services/StoryDropService.js';
import { listDirOnDevice, readFileOnDevice, writeFileOnDevice, deleteFileOnDevice } from '../../machines/index.js';

const idOf = (req: Request): string => String(req.params.id ?? '');

const userOf = (req: Request): { id: string; email: string } =>
  (req as unknown as { user: { id: string; email: string } }).user;

const queryString = (req: Request, key: string): string | undefined => {
  const v = req.query[key];
  return typeof v === 'string' ? v : undefined;
};

const localSha = (content: string): string => crypto.createHash('sha256').update(content).digest('hex');

type OwnedProject = ProjectMetadata & { ownerId: string };

const repositoryOf = (project: ProjectMetadata): { owner: string; repo: string } | undefined =>
  project.giteaOwner && project.giteaRepo ? { owner: project.giteaOwner, repo: project.giteaRepo } : undefined;

const NO_REPOSITORY = 'this project has no repository';

function devicePath(project: ProjectMetadata, p: string): string {
  const base = project.executionTarget?.kind === 'local-device' ? project.executionTarget.path : undefined;
  return base ? path.posix.join(base, p) : p;
}

async function readLocalContent(deviceId: string, ownerId: string, target: string): Promise<string | null> {
  try {
    return await readFileOnDevice(deviceId, ownerId, `files-read-${crypto.randomUUID()}`, target);
  } catch (err) {
    if (err instanceof Error && /ENOENT/.test(err.message)) return null;
    throw err;
  }
}

export interface ProjectFilesRouterDeps {
  projectRepoService: Pick<ProjectRepoService, 'editorCredential'>;
  giteaService: Pick<GiteaService, 'listDirectory' | 'getFileContent' | 'updateFile' | 'deleteFile'>;
  getOwnedProject: (id: string, principal: Principal) => Promise<ProjectMetadata | undefined>;
  drops: Pick<RepositoryDropService, 'drop'>;
  storyDrops: Pick<StoryDropService, 'drop'>;
}

export function projectFilesRouter(deps: ProjectFilesRouterDeps): Router {
  const { projectRepoService, giteaService, drops, storyDrops } = deps;
  const router = Router();

  const ownedProject = async (req: Request): Promise<OwnedProject | undefined> => {
    const project = await deps.getOwnedProject(idOf(req), principalFrom(req));
    return project?.ownerId ? { ...project, ownerId: project.ownerId } : undefined;
  };

  router.post('/:id/files/drop', asyncRoute(async (req, res) => {
    if (!req.is(DROP_TYPE)) return res.status(415).json({ error: `Send a drop as ${DROP_TYPE}.` });
    const project = await ownedProject(req);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    await withReceivedDrop(req, async (read) => {
      if (!read.ok) return res.status(400).json({ error: read.why });
      const { ref, message, leafId } = read.settings;
      if (leafId) {
        const outcome = await storyDrops.drop(userOf(req).id, project.id, leafId, read.files, message);
        if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.why });
        return res.status(201).json(outcome);
      }
      try {
        const outcome = await drops.drop(project, read.files, { ref, message });
        if (!outcome.ok) return res.status(409).json({ error: outcome.why });
        return res.status(201).json(outcome);
      } catch (err) {
        if (err instanceof GiteaConflictError) return res.status(409).json({ error: err.message });
        throw err;
      }
    });
  }));

  router.get('/:id/files', asyncRoute(async (req, res) => {
    const project = await ownedProject(req);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const dirPath = queryString(req, 'path') ?? '';
    if (!isSafeRepoDir(dirPath)) return res.status(400).json({ error: 'path must stay inside the repository.' });

    if (project.executionTarget?.kind === 'local-device') {
      const entries = await listDirOnDevice(project.executionTarget.deviceId, project.ownerId, devicePath(project, dirPath));
      return res.json({ path: dirPath, entries });
    }

    const repository = repositoryOf(project);
    if (!repository) return res.status(409).json({ error: NO_REPOSITORY });
    const { token } = await projectRepoService.editorCredential(project.ownerId);
    const entries = await giteaService.listDirectory(token, repository.owner, repository.repo, dirPath, queryString(req, 'ref'));
    res.json({ path: dirPath, entries });
  }));

  router.get('/:id/files/content', asyncRoute(async (req, res) => {
    const project = await ownedProject(req);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const filePath = queryString(req, 'path') ?? '';
    if (!isSafeRepoFilePath(filePath)) return res.status(400).json({ error: 'path must name a file inside the repository.' });

    if (project.executionTarget?.kind === 'local-device') {
      const content = await readLocalContent(project.executionTarget.deviceId, project.ownerId, devicePath(project, filePath));
      if (content === null) return res.status(404).json({ error: 'File not found' });
      return res.json({ path: filePath, content, sha: localSha(content) });
    }

    const repository = repositoryOf(project);
    if (!repository) return res.status(409).json({ error: NO_REPOSITORY });
    const { token } = await projectRepoService.editorCredential(project.ownerId);
    const file = await giteaService.getFileContent(token, repository.owner, repository.repo, filePath, queryString(req, 'ref'));
    if (!file) return res.status(404).json({ error: 'File not found' });
    res.json(file);
  }));

  router.put('/:id/files/content', asyncRoute(async (req, res) => {
    const project = await ownedProject(req);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const filePath = at(req.body, 'path');
    const content = at(req.body, 'content');
    const sha = at(req.body, 'sha');
    if (typeof filePath !== 'string' || !isSafeRepoFilePath(filePath)) {
      return res.status(400).json({ error: 'path must name a file inside the repository.' });
    }
    if (typeof content !== 'string') return res.status(400).json({ error: 'content is required.' });
    if (typeof sha !== 'string' || !sha) {
      return res.status(400).json({ error: 'sha is required — open the file first so an edit knows what it is replacing.' });
    }

    if (project.executionTarget?.kind === 'local-device') {
      const { deviceId } = project.executionTarget;
      const target = devicePath(project, filePath);
      const existing = await readLocalContent(deviceId, project.ownerId, target);
      if (existing !== null && localSha(existing) !== sha) {
        return res.status(409).json({ error: `"${filePath}" changed since it was loaded — reload and try again.` });
      }
      await writeFileOnDevice(deviceId, project.ownerId, `files-write-${crypto.randomUUID()}`, target, content);
      return res.json({ sha: localSha(content) });
    }

    const message = at(req.body, 'message');
    const ref = at(req.body, 'ref');
    const repository = repositoryOf(project);
    if (!repository) return res.status(409).json({ error: NO_REPOSITORY });
    const { token } = await projectRepoService.editorCredential(project.ownerId);
    try {
      const result = await giteaService.updateFile(
        token, repository.owner, repository.repo, filePath, content,
        typeof message === 'string' && message.trim() ? message.trim() : `Update ${filePath}`,
        sha, typeof ref === 'string' ? ref : undefined,
      );
      res.json(result);
    } catch (err) {
      if (err instanceof GiteaConflictError) return res.status(409).json({ error: err.message });
      throw err;
    }
  }));

  router.delete('/:id/files/content', asyncRoute(async (req, res) => {
    const project = await ownedProject(req);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const filePath = queryString(req, 'path') ?? '';
    const sha = queryString(req, 'sha') ?? '';
    if (!isSafeRepoFilePath(filePath)) return res.status(400).json({ error: 'path must name a file inside the repository.' });
    if (!sha) return res.status(400).json({ error: 'sha is required — open the file first so a delete knows what it is removing.' });

    if (project.executionTarget?.kind === 'local-device') {
      const { deviceId } = project.executionTarget;
      const target = devicePath(project, filePath);
      const existing = await readLocalContent(deviceId, project.ownerId, target);
      if (existing === null) return res.status(409).json({ error: `"${filePath}" no longer exists.` });
      if (localSha(existing) !== sha) {
        return res.status(409).json({ error: `"${filePath}" changed since it was loaded — reload and try again.` });
      }
      await deleteFileOnDevice(deviceId, project.ownerId, target);
      return res.json({ success: true });
    }

    const repository = repositoryOf(project);
    if (!repository) return res.status(409).json({ error: NO_REPOSITORY });
    const { token } = await projectRepoService.editorCredential(project.ownerId);
    try {
      await giteaService.deleteFile(
        token, repository.owner, repository.repo, filePath,
        `Delete ${filePath}`, sha, queryString(req, 'ref'),
      );
      res.json({ success: true });
    } catch (err) {
      if (err instanceof GiteaConflictError) return res.status(409).json({ error: err.message });
      throw err;
    }
  }));

  return router;
}
