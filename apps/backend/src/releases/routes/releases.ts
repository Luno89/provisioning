import { Router, type Request, type Response } from 'express';
import { asyncRoute, type ProjectMetadata, principalFrom, type Principal } from '../../platform/index.js';
import type { OdooReleaseService } from '../services/OdooReleaseService.js';
import type { SignIn } from '../../projects/index.js';

const userOf = (req: Request): { id: string; email: string } =>
  (req as unknown as { user: { id: string; email: string } }).user;

export interface ReleasesRouterDeps {
  releases: Pick<OdooReleaseService, 'list' | 'decide' | 'retest' | 'addresses' | 'rollBackOffer' | 'rollBack' | 'releaseAgain' | 'files'>;
  getOwnedProject: (id: string, principal: Principal) => Promise<ProjectMetadata | undefined | null>;
  signIns: (project: ProjectMetadata) => Promise<SignIn[]>;
}

export function releasesRouter(deps: ReleasesRouterDeps): Router {
  const router = Router();

  const owned = async (req: Request, res: Response) => {
    const project = await deps.getOwnedProject(String(req.params.id), principalFrom(req));
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
      const outcome = await deps.releases.decide(project.ownerId ?? userOf(req).id, String(req.params.releaseId), decision, req.body?.confirm === true);
      if ('error' in outcome) return res.status(outcome.status).json({ error: outcome.error, ...(outcome.losing ? { losing: outcome.losing } : {}) });
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

  router.get('/:id/releases/:releaseId/files', asyncRoute(async (req: Request, res: Response) => {
    const project = await owned(req, res);
    if (!project) return;
    const outcome = await deps.releases.files(project.ownerId ?? userOf(req).id, project, String(req.params.releaseId));
    if ('error' in outcome) return res.status(outcome.status).json({ error: outcome.error });
    return res.json(outcome);
  }));

  router.post('/:id/releases/:releaseId/again', asyncRoute(async (req: Request, res: Response) => {
    const project = await owned(req, res);
    if (!project) return;
    if (project.removal) return res.status(409).json({ error: 'This project is being deleted' });
    const outcome = await deps.releases.releaseAgain(project.ownerId ?? userOf(req).id, project, String(req.params.releaseId));
    if ('error' in outcome) return res.status(outcome.status).json({ error: outcome.error });
    if ('skipped' in outcome) return res.status(409).json({ error: outcome.skipped });
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
