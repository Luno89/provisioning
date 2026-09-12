import { Router, type Request } from 'express';
import crypto from 'crypto';
import path from 'path';
import { asyncRoute } from '../middleware/async-route.js';
import { isSafeRepoDir, isSafeRepoFilePath } from '../lib/project-file-paths.js';
import { GiteaConflictError } from '../services/GiteaService.js';
import { listDirOnDevice, readFileOnDevice, writeFileOnDevice, deleteFileOnDevice } from '../lib/local-agent-registry.js';

const idOf = (req: Request): string => String(req.params.id ?? '');

const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

const queryString = (req: Request, key: string): string | undefined => {
  const v = req.query[key];
  return typeof v === 'string' ? v : undefined;
};

const localSha = (content: string): string => crypto.createHash('sha256').update(content).digest('hex');

function devicePath(project: { executionTarget?: { kind: string; deviceId: string; path?: string } }, p: string): string {
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

export function projectFilesRouter(deps: Record<string, any>): Router {
  const { projectRepoService, giteaService, getOwnedProject } = deps;
  const router = Router();

  router.get('/:id/files', asyncRoute(async (req, res) => {
    const project = await getOwnedProject(idOf(req), userOf(req));
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const dirPath = queryString(req, 'path') ?? '';
    if (!isSafeRepoDir(dirPath)) return res.status(400).json({ error: 'path must stay inside the repository.' });

    if (project.executionTarget?.kind === 'local-device') {
      const entries = await listDirOnDevice(project.executionTarget.deviceId, project.ownerId, devicePath(project, dirPath));
      return res.json({ path: dirPath, entries });
    }

    const { token } = await projectRepoService.editorCredential(project.ownerId);
    const entries = await giteaService.listDirectory(token, project.giteaOwner, project.giteaRepo, dirPath, queryString(req, 'ref'));
    res.json({ path: dirPath, entries });
  }));

  router.get('/:id/files/content', asyncRoute(async (req, res) => {
    const project = await getOwnedProject(idOf(req), userOf(req));
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const filePath = queryString(req, 'path') ?? '';
    if (!isSafeRepoFilePath(filePath)) return res.status(400).json({ error: 'path must name a file inside the repository.' });

    if (project.executionTarget?.kind === 'local-device') {
      const content = await readLocalContent(project.executionTarget.deviceId, project.ownerId, devicePath(project, filePath));
      if (content === null) return res.status(404).json({ error: 'File not found' });
      return res.json({ path: filePath, content, sha: localSha(content) });
    }

    const { token } = await projectRepoService.editorCredential(project.ownerId);
    const file = await giteaService.getFileContent(token, project.giteaOwner, project.giteaRepo, filePath, queryString(req, 'ref'));
    if (!file) return res.status(404).json({ error: 'File not found' });
    res.json(file);
  }));

  router.put('/:id/files/content', asyncRoute(async (req, res) => {
    const project = await getOwnedProject(idOf(req), userOf(req));
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { path: filePath, content, sha } = req.body ?? {};
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

    const { message, ref } = req.body ?? {};
    const { token } = await projectRepoService.editorCredential(project.ownerId);
    try {
      const result = await giteaService.updateFile(
        token, project.giteaOwner, project.giteaRepo, filePath, content,
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
    const project = await getOwnedProject(idOf(req), userOf(req));
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

    const { token } = await projectRepoService.editorCredential(project.ownerId);
    try {
      await giteaService.deleteFile(
        token, project.giteaOwner, project.giteaRepo, filePath,
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
