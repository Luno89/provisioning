import { Router, type Request, type Response } from 'express';
import { asyncRoute } from '../../platform/index.js';
import type { ProjectSharingService, SharingOutcome } from '../../projects/index.js';

const personOf = (req: Request) => (req as unknown as { user: { id: string; email: string } }).user;

const answer = <T>(res: Response, outcome: SharingOutcome<T>) => (
  outcome.ok ? res.json(outcome.value) : res.status(outcome.status).json({ error: outcome.why })
);

export function projectSharingRouter(deps: { sharing: ProjectSharingService }): Router {
  const router = Router();
  const id = (req: Request) => String(req.params.id ?? '');

  router.get('/:id', asyncRoute(async (req, res) => {
    answer(res, await deps.sharing.preview(personOf(req).id, id(req)));
  }));

  router.get('/:id/group-check', asyncRoute(async (req, res) => {
    answer(res, await deps.sharing.groupCheck(personOf(req).id, id(req), req.query.name));
  }));

  router.post('/:id', asyncRoute(async (req, res) => {
    const person = personOf(req);
    answer(res, await deps.sharing.share({ id: person.id, email: person.email }, id(req), req.body?.group));
  }));

  router.delete('/:id', asyncRoute(async (req, res) => {
    answer(res, await deps.sharing.takeBack(personOf(req).id, id(req), req.body?.confirm));
  }));

  return router;
}
