import { Router, type Request, type Response } from 'express';
import { asyncRoute } from '../../platform/middleware/async-route.js';
import type { ProjectMetadata } from '../../platform/lib/types.js';
import type { ProjectAppService } from '../services/ProjectAppService.js';

const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

export interface ProjectAppRouterDeps {
  apps: Pick<ProjectAppService, 'app' | 'open'>;
  getOwnedProject: (id: string, user: { id: string; email: string; isAdmin?: boolean }) => Promise<ProjectMetadata | undefined | null>;
}

export function projectAppRouter(deps: ProjectAppRouterDeps): Router {
  const router = Router();

  const owned = async (req: Request, res: Response) => {
    const project = await deps.getOwnedProject(String(req.params.id), userOf(req));
    if (!project) res.status(404).json({ error: 'Project not found' });
    return project ?? undefined;
  };

  router.get('/:id/app', asyncRoute(async (req: Request, res: Response) => {
    const project = await owned(req, res);
    if (!project) return;
    res.json({ app: (await deps.apps.app(project)) ?? null });
  }));

  router.post('/:id/app/open', asyncRoute(async (req: Request, res: Response) => {
    const project = await owned(req, res);
    if (!project) return;
    const mode = (req.body as { mode?: unknown } | undefined)?.mode;
    if (mode !== 'local' && mode !== 'public') return res.status(400).json({ error: 'mode is local (this machine) or public (anyone with the address)' });
    const opened = await deps.apps.open(project, mode);
    if ('error' in opened) return res.status(opened.status).json({ error: opened.error });
    return res.json({ app: opened });
  }));

  return router;
}
