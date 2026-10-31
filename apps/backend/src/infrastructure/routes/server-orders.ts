import { Router, type Request, type RequestHandler, type Response } from 'express';
import { asyncRoute } from '../../platform/index.js';
import { withoutOrderSecrets } from '../lib/server-orders.js';
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

const sendOrder = (res: Response, body: unknown, status = 200): void => {
  res.status(status).json(withoutOrderSecrets(body));
};

export function serverOrdersRouter(deps: { serverOrders: ServerOrderService; operatorOnly: RequestHandler }): Router {
  const { serverOrders } = deps;
  const router = Router();
  router.use(deps.operatorOnly);

  router.get('/', asyncRoute(async (req, res) => {
    sendOrder(res, await serverOrders.list(userOf(req).id));
  }));

  router.get('/sign-in-providers', (req, res) => {
    res.json(serverOrders.signInProviders(text(req.query.domain) || undefined));
  });

  router.post('/quote', asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      sendOrder(res, await serverOrders.quote(userOf(req).id, {
        planCode: text(body.planCode),
        planLabel: text(body.planLabel),
        datacenter: text(body.datacenter),
        domain: text(body.domain),
        ingressDomain: text(body.ingressDomain),
        acmeEmail: text(body.acmeEmail),
        domainDns: text(body.domainDns) || undefined,
        ingressDns: text(body.ingressDns) || undefined,
        signIn: body.signIn,
      }), 201);
    } catch (error) {
      answer(res, error);
    }
  }));

  router.get('/zones', asyncRoute(async (req, res) => {
    const asked = ([] as unknown[]).concat(req.query.zone ?? []).map(text).map((zone) => zone.trim()).filter(Boolean);
    if (asked.length === 0 || asked.length > 2) {
      res.status(400).json({ error: 'Name one or two zones as ?zone=' });
      return;
    }
    res.json(await serverOrders.zones(userOf(req).id, asked));
  }));

  router.get('/:id', asyncRoute(async (req, res) => {
    try {
      sendOrder(res, await serverOrders.get(userOf(req).id, String(req.params.id)));
    } catch (error) {
      answer(res, error);
    }
  }));

  router.post('/:id/buy', asyncRoute(async (req, res) => {
    try {
      sendOrder(res, await serverOrders.buy(userOf(req).id, String(req.params.id), (req.body ?? {}).confirmedTotal));
    } catch (error) {
      answer(res, error);
    }
  }));

  router.delete('/:id', asyncRoute(async (req, res) => {
    try {
      sendOrder(res, await serverOrders.cancel(userOf(req).id, String(req.params.id)));
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
