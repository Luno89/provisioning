import { Router, type Request } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import type { SecretRequestService } from '../services/SecretRequestService.js';

export interface SecretRequestsRouterDeps {
  secrets: SecretRequestService;
}

const userOf = (req: Request): { id: string } =>
  (req as unknown as { user: { id: string } }).user;

const idOf = (req: Request): string => String(req.params.id ?? '');

const query = (req: Request, key: string): string | undefined =>
  (typeof req.query[key] === 'string' ? req.query[key] as string : undefined);

export function secretRequestsRouter(deps: SecretRequestsRouterDeps): Router {
  const router = Router();

  router.get('/', asyncRoute(async (req, res) => {
    res.json(await deps.secrets.list(userOf(req).id, {
      conversationId: query(req, 'conversationId'),
      projectId: query(req, 'projectId'),
      treeId: query(req, 'treeId'),
    }));
  }));

  router.post('/:id/submit', asyncRoute(async (req, res) => {
    const value = typeof req.body?.value === 'string' ? req.body.value : '';
    const decided = await deps.secrets.submit(userOf(req).id, idOf(req), value);
    if (!decided.ok) return res.status(decided.status).json({ error: decided.error });
    res.json(decided.request);
  }));

  router.post('/:id/dismiss', asyncRoute(async (req, res) => {
    const decided = await deps.secrets.dismiss(userOf(req).id, idOf(req));
    if (!decided.ok) return res.status(decided.status).json({ error: decided.error });
    res.json(decided.request);
  }));

  return router;
}
