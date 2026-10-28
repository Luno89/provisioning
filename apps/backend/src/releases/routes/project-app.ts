import { Router, type Request, type Response } from 'express';
import { asyncRoute, type ProjectMetadata, principalFrom, type Principal } from '../../platform/index.js';
import type { ProjectAppService } from '../services/ProjectAppService.js';

export interface ProjectAppRouterDeps {
  apps: Pick<ProjectAppService, 'app' | 'open'>;
  getOwnedProject: (id: string, principal: Principal) => Promise<ProjectMetadata | undefined | null>;
}

export function projectAppRouter(deps: ProjectAppRouterDeps): Router {
  const router = Router();

  const owned = async (req: Request, res: Response) => {
    const project = await deps.getOwnedProject(String(req.params.id), principalFrom(req));
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
