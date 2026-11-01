import { Router, type Request, type Response } from 'express';
import { asyncRoute, fieldsOf } from '../../platform/index.js';
import { PoisoningError, type PoisoningService } from '../services/PoisoningService.js';
import { retireScopeFrom } from '../lib/poisoning.js';

export interface PoisoningRouterDeps {
  poisoning: Pick<PoisoningService, 'list' | 'dismiss' | 'retire'>;
}

const userOf = (req: Request): { id: string } =>
  (req as unknown as { user: { id: string } }).user;

const answered = async (res: Response, work: () => Promise<unknown>): Promise<void> => {
  try {
    res.json(await work());
  } catch (error) {
    if (error instanceof PoisoningError) res.status(error.status).json({ error: error.message });
    else throw error;
  }
};

export function poisoningRouter(deps: PoisoningRouterDeps): Router {
  const router = Router();

  router.get('/', asyncRoute(async (req: Request, res: Response) => {
    const runId = typeof req.query.runId === 'string' && req.query.runId ? req.query.runId : undefined;
    await answered(res, async () => ({ signals: await deps.poisoning.list(userOf(req).id, { ...(runId ? { runIds: [runId] } : { open: req.query.all !== '1' }) }) }));
  }));

  router.post('/:id/dismiss', asyncRoute(async (req: Request, res: Response) => {
    const { because: said } = fieldsOf(req.body);
    const because = typeof said === 'string' ? said : undefined;
    await answered(res, () => deps.poisoning.dismiss(userOf(req).id, String(req.params.id), because));
  }));

  router.post('/:id/retire', asyncRoute(async (req: Request, res: Response) => {
    const scope = retireScopeFrom(fieldsOf(req.body).scope);
    if (!scope) {
      res.status(400).json({ error: 'say what to retire: "run" for what this run left, or "source" for everything learned from the host it names' });
      return;
    }
    await answered(res, () => deps.poisoning.retire(userOf(req).id, String(req.params.id), scope));
  }));

  return router;
}
