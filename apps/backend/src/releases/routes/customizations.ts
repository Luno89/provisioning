import { Router, type Request, type Response } from 'express';
import { asyncRoute, type ProjectMetadata } from '../../platform/index.js';
import type { CustomizationsOutcome, CustomizationsService } from '../services/CustomizationsService.js';

export interface CustomizationsRouterDeps {
  customizations: Pick<CustomizationsService, 'drift' | 'propose'>;
  channelOf(project: ProjectMetadata): Promise<string | undefined>;
  getOwnedProject(id: string, user: { id: string }): Promise<ProjectMetadata | undefined>;
}

const userOf = (req: Request): { id: string } => (req as unknown as { user: { id: string } }).user;

const answer = <T>(res: Response, outcome: CustomizationsOutcome<T>, status = 200) =>
  (outcome.ok ? res.status(status).json(outcome.value) : res.status(outcome.status).json({ error: outcome.error }));

export function customizationsRouter(deps: CustomizationsRouterDeps): Router {
  const router = Router();

  router.get('/:id/customizations', asyncRoute(async (req, res) => {
    const project = await deps.getOwnedProject(String(req.params.id), userOf(req));
    if (!project) return res.status(404).json({ error: 'You have no project with that id' });
    return answer(res, await deps.customizations.drift(project.ownerId ?? userOf(req).id, project.id));
  }));

  router.post('/:id/customizations/adopt', asyncRoute(async (req, res) => {
    const project = await deps.getOwnedProject(String(req.params.id), userOf(req));
    if (!project) return res.status(404).json({ error: 'You have no project with that id' });
    const channel = await deps.channelOf(project);
    return answer(res, await deps.customizations.propose(project.ownerId ?? userOf(req).id, project.id, req.body, channel ? { conversationId: channel } : {}), 201);
  }));

  return router;
}
