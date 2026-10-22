import { Router, type Request } from 'express';
import { asyncRoute } from '../../platform/middleware/async-route.js';
import { TEST_MAIL } from '../../platform/lib/mail.js';
import { MailError, type MailService } from '../../platform/services/MailService.js';
import type { NotificationService } from '../services/NotificationService.js';

export interface NotificationsRouterDeps {
  notifications: Pick<NotificationService, 'view' | 'set'>;
  mail: Pick<MailService, 'toOwner'>;
}

const userOf = (req: Request): { id: string; email?: string } => (req as Request & { user: { id: string; email?: string } }).user;

export function notificationsRouter({ notifications, mail }: NotificationsRouterDeps): Router {
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

  return router;
}
