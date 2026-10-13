import { Router, type Request, type Response } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import type { OdooReleaseService } from '../services/OdooReleaseService.js';
import type { ProjectMetadata } from '../lib/types.js';
import type { SignIn } from '../services/ProjectSecretsService.js';

const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

export interface ReleasesRouterDeps {
  releases: Pick<OdooReleaseService, 'list' | 'decide' | 'retest' | 'addresses' | 'rollBackOffer' | 'rollBack'>;
  getOwnedProject: (id: string, user: { id: string; email: string; isAdmin?: boolean }) => Promise<ProjectMetadata | undefined | null>;
  signIns: (project: ProjectMetadata) => Promise<SignIn[]>;
}

export function releasesRouter(deps: ReleasesRouterDeps): Router {
  const router = Router();

  const owned = async (req: Request, res: Response) => {
    const project = await deps.getOwnedProject(String(req.params.id), userOf(req));
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return undefined;
    }
    return project;
  };

  router.get('/:id/releases', asyncRoute(async (req: Request, res: Response) => {
    const project = await owned(req, res);
    if (!project) return;
    const ownerId = project.ownerId ?? userOf(req).id;
    const [releases, addresses, rollBack] = await Promise.all([deps.releases.list(ownerId, project.id), deps.releases.addresses(project.id), deps.releases.rollBackOffer(ownerId, project.id)]);
    res.json({ releases, addresses, ...(rollBack ? { rollBack } : {}) });
  }));

  router.get('/:id/sign-in', asyncRoute(async (req: Request, res: Response) => {
    const project = await owned(req, res);
    if (!project) return;
    res.set('Cache-Control', 'no-store');
    res.json({ signIns: await deps.signIns(project) });
  }));

  for (const [path, decision] of [['cut-over', 'cutOver'], ['discard', 'discard']] as const) {
    router.post(`/:id/releases/:releaseId/${path}`, asyncRoute(async (req: Request, res: Response) => {
      const project = await owned(req, res);
      if (!project) return;
      const outcome = await deps.releases.decide(project.ownerId ?? userOf(req).id, String(req.params.releaseId), decision);
      if ('error' in outcome) return res.status(outcome.status).json({ error: outcome.error });
      return res.status(202).json({ release: outcome });
    }));
  }

  router.post('/:id/releases/:releaseId/retest', asyncRoute(async (req: Request, res: Response) => {
    const project = await owned(req, res);
    if (!project) return;
    const outcome = await deps.releases.retest(project.ownerId ?? userOf(req).id, String(req.params.releaseId));
    if ('error' in outcome) return res.status(outcome.status).json({ error: outcome.error });
    return res.status(202).json({ release: outcome });
  }));

  router.post('/:id/releases/:releaseId/roll-back', asyncRoute(async (req: Request, res: Response) => {
    const project = await owned(req, res);
    if (!project) return;
    const outcome = await deps.releases.rollBack(project.ownerId ?? userOf(req).id, project, String(req.params.releaseId));
    if ('error' in outcome) return res.status(outcome.status).json({ error: outcome.error });
    return res.status(202).json({ release: outcome });
  }));

  return router;
}
