import { Router, type Request, type Response } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import type { ProcedureService } from '../services/ProcedureService.js';

export interface ProceduresRouterDeps {
  procedures: ProcedureService;
}

const userOf = (req: Request): { id: string } =>
  (req as unknown as { user: { id: string } }).user;

export function proceduresRouter(deps: ProceduresRouterDeps): Router {
  const router = Router();

  router.get('/', asyncRoute(async (req: Request, res: Response) => {
    res.json(await deps.procedures.list(userOf(req).id));
  }));

  router.post('/check', asyncRoute(async (req: Request, res: Response) => {
    res.json({ problems: await deps.procedures.check(userOf(req).id, req.body) });
  }));

  router.get('/:id', asyncRoute(async (req: Request, res: Response) => {
    const found = await deps.procedures.get(userOf(req).id, String(req.params.id));
    if (!found) return res.status(404).json({ error: 'There is no procedure with that id' });
    return res.json(found);
  }));

  router.get('/:id/track-record', asyncRoute(async (req: Request, res: Response) => {
    res.json({ records: await deps.procedures.trackRecords(userOf(req).id, String(req.params.id)) });
  }));

  router.put('/:id/builder', asyncRoute(async (req: Request, res: Response) => {
    const outcome = await deps.procedures.saveBuilderCode(userOf(req).id, String(req.params.id), req.body?.code);
    if (!outcome.saved) return res.status(400).json({ error: 'The builder code does not make a procedure that checks clean', problems: outcome.problems });
    return res.json({ procedure: outcome.procedure, problems: outcome.problems });
  }));

  router.put('/:id', asyncRoute(async (req: Request, res: Response) => {
    const outcome = await deps.procedures.save(userOf(req).id, String(req.params.id), req.body);
    if (!outcome.saved) return res.status(400).json({ error: 'The procedure does not check clean', problems: outcome.problems });
    return res.json({ procedure: outcome.procedure, problems: outcome.problems });
  }));

  router.delete('/:id', asyncRoute(async (req: Request, res: Response) => {
    const removed = await deps.procedures.remove(userOf(req).id, String(req.params.id));
    if (!removed) return res.status(404).json({ error: 'You have no copy of that procedure to delete' });
    return res.json({ ok: true });
  }));

  return router;
}
