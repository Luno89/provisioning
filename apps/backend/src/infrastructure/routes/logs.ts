import { Router, type Request } from 'express';
import fs from 'fs/promises';
import { allowed, principalFrom, type ClusterMetadata, type Database, type Principal } from '../../platform/index.js';
import type { AppService } from '../services/AppService.js';

export interface LogsRouterDeps {
  db: Pick<Database, 'releases' | 'projects'>;
  clusterService: { getById(id: string, principal: Principal, action: 'see-everything'): Promise<Pick<ClusterMetadata, 'lastLogPath'> | undefined> };
  appService: Pick<AppService, 'getAll'>;
}

const userOf = (req: Request): { id: string; email: string } =>
  (req as unknown as { user: { id: string; email: string } }).user;

export function logsRouter(deps: LogsRouterDeps): Router {
  const { db, clusterService, appService } = deps;
  const router = Router();

  const ownPipelineRun = async (id: string, principal: Principal) => {
    const run = (await db.releases.getPipelineRuns()).find((entry) => entry.id === id);
    const project = run ? (await db.projects.getProjects()).find((entry) => entry.id === run.projectId) : undefined;
    return project && allowed(principal, 'see', { kind: 'project', ownerId: project.ownerId }) ? run : undefined;
  };

  router.get('/:type/:id', async (req, res) => {
    const { type, id } = req.params;
    const logPath = type === 'cluster'
      ? (await clusterService.getById(id, principalFrom(req), 'see-everything'))?.lastLogPath
      : type === 'pipeline'
      ? (await ownPipelineRun(id, principalFrom(req)))?.logFile
      : (await appService.getAll(userOf(req).id)).find((d) => d.id === id)?.lastLogPath;
    if (!logPath) return res.json({ content: 'Initializing...' });
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
