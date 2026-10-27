import { Router, type Request } from 'express';
import fs from 'fs/promises';
import { ownsProject } from '../../platform/index.js';

const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

export function logsRouter(deps: Record<string, any>): Router {
  const { db, clusterService, appService } = deps;
  const router = Router();

  const ownPipelineRun = async (id: string, user: { id: string; isAdmin?: boolean }) => {
    const run = (await db.releases.getPipelineRuns()).find((entry: { id: string }) => entry.id === id);
    const project = run ? (await db.projects.getProjects()).find((entry: { id: string }) => entry.id === run.projectId) : undefined;
    return project && ownsProject(project, user) ? run : undefined;
  };

  router.get('/:type/:id', async (req, res) => {
    const { type, id } = req.params;
    const resource = type === 'cluster'
      ? await clusterService.getById(id, userOf(req).id)
      : type === 'pipeline'
      ? await ownPipelineRun(id, userOf(req))
      : (await appService.getAll(userOf(req).id)).find((d: any) => d.id === id);
    const logPath = type === 'pipeline' ? (resource as any)?.logFile : (resource as any)?.lastLogPath;
    if (!resource || !logPath) return res.json({ content: 'Initializing...' });
    try {
      const content = await fs.readFile(logPath, 'utf-8');
      res.json({ content });
    }
    catch {
      res.json({ content: 'Waiting for logs...' });
    }
  });

  return router;
}
