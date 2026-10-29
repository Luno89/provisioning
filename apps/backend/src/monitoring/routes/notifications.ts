import { Router, type Request } from 'express';
import { asyncRoute, TEST_MAIL, MailError, type MailService } from '../../platform/index.js';
import type { NotificationService } from '../services/NotificationService.js';
import { PushError, type PushService } from '../services/PushService.js';

export interface NotificationsRouterDeps {
  notifications: Pick<NotificationService, 'view' | 'set'>;
  mail: Pick<MailService, 'toOwner'>;
  push?: Pick<PushService, 'view' | 'subscribe' | 'remove' | 'test'> | undefined;
}

const userOf = (req: Request): { id: string; email?: string } => (req as Request & { user: { id: string; email?: string } }).user;

export function notificationsRouter({ notifications, mail, push }: NotificationsRouterDeps): Router {
  const router = Router();

  router.get('/', asyncRoute(async (req, res) => {
    const user = userOf(req);
    res.json({ ...(await notifications.view(user.id)), ...(user.email ? { address: user.email } : {}) });
  }));

  router.put('/', asyncRoute(async (req, res) => {
    const outcome = await notifications.set(userOf(req).id, (req.body as { email?: unknown } | undefined)?.email);
    if (!outcome.ok) return res.status(400).json({ error: outcome.error });
    return res.json(outcome.value);
  }));

  router.post('/test-email', asyncRoute(async (req, res) => {
    try {
      await mail.toOwner(userOf(req).id, TEST_MAIL);
      res.json({ sent: true });
    } catch (err) {
      if (err instanceof MailError) return res.status(err.status).json({ error: err.message });
      return res.status(502).json({ error: `it could not be sent: ${(err as Error).message}` });
    }
  }));

  const pushed = (work: (ownerId: string, req: Request) => Promise<unknown>) => asyncRoute(async (req, res) => {
    if (!push) return res.status(404).json({ error: 'this server sends no push notifications' });
    try {
      return res.json(await work(userOf(req).id, req));
    } catch (err) {
      if (err instanceof PushError) return res.status(err.status).json({ error: err.message });
      throw err;
    }
  });

  router.get('/push', pushed((ownerId) => push!.view(ownerId)));
  router.post('/push', pushed((ownerId, req) => push!.subscribe(ownerId, (req.body as { subscription?: unknown } | undefined)?.subscription, req.get('user-agent'))));
  router.delete('/push/:id', pushed((ownerId, req) => push!.remove(ownerId, String(req.params.id))));
  router.post('/push/test', pushed((ownerId) => push!.test(ownerId)));

  return router;
}
