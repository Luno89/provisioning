import { Router, type Request, type Response } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import type { ClientImportService, ImportOutcome } from '../services/ClientImportService.js';
import type { ProjectMetadata } from '../lib/types.js';

export interface ClientImportRouterDeps {
  imports: Pick<ClientImportService, 'view' | 'upload'>;
  getOwnedProject(id: string, user: { id: string }): Promise<ProjectMetadata | undefined>;
}

const userOf = (req: Request): { id: string } => (req as unknown as { user: { id: string } }).user;

const answer = <T>(res: Response, outcome: ImportOutcome<T>, status = 200) =>
  (outcome.ok ? res.status(status).json(outcome.value) : res.status(outcome.status).json({ error: outcome.error }));

export function clientImportRouter(deps: ClientImportRouterDeps): Router {
  const router = Router();

  router.get('/:id/import', asyncRoute(async (req, res) => {
    const project = await deps.getOwnedProject(String(req.params.id), userOf(req));
    if (!project) return res.status(404).json({ error: 'You have no project with that id' });
    return answer(res, await deps.imports.view(project.ownerId ?? userOf(req).id, project.id));
  }));

  router.put('/:id/import', asyncRoute(async (req, res) => {
    const project = await deps.getOwnedProject(String(req.params.id), userOf(req));
    if (!project) {
      req.resume();
      return res.status(404).json({ error: 'You have no project with that id' });
    }
    const outcome = await deps.imports.upload(project.ownerId ?? userOf(req).id, project.id, { mode: req.query.mode ?? 'copy', bytes: Number(req.headers['content-length']), body: req });
    if (!outcome.ok && !req.readableEnded) req.resume();
    return answer(res, outcome, 201);
  }));

  return router;
}
