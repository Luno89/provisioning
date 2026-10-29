import { Router, type Request, type RequestHandler, type Response } from 'express';
import { asyncRoute } from '../../platform/index.js';
import { ServerOrderProblem, type ServerOrderService } from '../services/ServerOrderService.js';

const userOf = (req: Request): { id: string } => (req as unknown as { user: { id: string } }).user;

const answer = (res: Response, error: unknown): void => {
  if (error instanceof ServerOrderProblem) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  res.status(502).json({ error: (error as Error).message });
};

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export function serverOrdersRouter(deps: { serverOrders: ServerOrderService; operatorOnly: RequestHandler }): Router {
  const { serverOrders } = deps;
  const router = Router();
  router.use(deps.operatorOnly);

  router.get('/', asyncRoute(async (req, res) => {
    res.json(await serverOrders.list(userOf(req).id));
  }));

  router.post('/quote', asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      res.status(201).json(await serverOrders.quote(userOf(req).id, {
        planCode: text(body.planCode),
        planLabel: text(body.planLabel),
        datacenter: text(body.datacenter),
        domain: text(body.domain),
        ingressDomain: text(body.ingressDomain),
        acmeEmail: text(body.acmeEmail),
      }));
    } catch (error) {
      answer(res, error);
    }
  }));

  router.get('/:id', asyncRoute(async (req, res) => {
    try {
      res.json(await serverOrders.get(userOf(req).id, String(req.params.id)));
    } catch (error) {
      answer(res, error);
    }
  }));

  router.post('/:id/buy', asyncRoute(async (req, res) => {
    try {
      res.json(await serverOrders.buy(userOf(req).id, String(req.params.id), (req.body ?? {}).confirmedTotal));
    } catch (error) {
      answer(res, error);
    }
  }));

  router.delete('/:id', asyncRoute(async (req, res) => {
    try {
      res.json(await serverOrders.cancel(userOf(req).id, String(req.params.id)));
    } catch (error) {
      answer(res, error);
    }
  }));

  router.post('/:id/setup-code', asyncRoute(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      res.json({ setupCode: await serverOrders.setupCode(userOf(req).id, String(req.params.id)) });
    } catch (error) {
      answer(res, error);
    }
  }));

  router.post('/:id/ssh-key', asyncRoute(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      res.json(await serverOrders.sshKey(userOf(req).id, String(req.params.id)));
    } catch (error) {
      answer(res, error);
    }
  }));

  return router;
}
