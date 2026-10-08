import { Router, type Request } from 'express';
import crypto from 'crypto';
import { asyncRoute } from '../middleware/async-route.js';
import { v4 as uuidv4 } from 'uuid';
import type { InviteMetadata } from '../lib/types.js';
import type { AccountRemovalService } from '../services/AccountRemovalService.js';

const idOf = (req: Request): string => String(req.params.id ?? '');

const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

export function adminRouter(deps: Record<string, any>): Router {
  const { db, requireAdmin } = deps;
  const router = Router();

  router.get('/invites', requireAdmin, async (req, res) => {
    res.json(await db.getInvites());
  });

  router.post('/invites', requireAdmin, async (req, res) => {
    const code = crypto.randomBytes(4).toString('hex');
    const invite: InviteMetadata = {
      id: code,
      code,
      createdBy: userOf(req).id,
      createdAt: new Date().toISOString(),
    };
    await db.saveInvite(invite);
    res.status(201).json(invite);
  });

  const removal = deps.removal as AccountRemovalService | undefined;
  const ELSEWHERE = 'Accounts are removed where their data lives, on the tenant backend, not on the root node';

  router.get('/people', requireAdmin, asyncRoute(async (_req, res) => {
    if (!removal) return res.status(404).json({ error: ELSEWHERE });
    return res.json({ people: await removal.people() });
  }));

  router.get('/people/:id/removal', requireAdmin, asyncRoute(async (req, res) => {
    if (!removal) return res.status(404).json({ error: ELSEWHERE });
    const preview = await removal.preview(idOf(req));
    if (!preview) return res.status(404).json({ error: 'There is no such account' });
    return res.json(preview);
  }));

  router.delete('/people/:id', requireAdmin, asyncRoute(async (req, res) => {
    if (!removal) return res.status(404).json({ error: ELSEWHERE });
    const confirm = typeof req.body?.confirm === 'string' ? req.body.confirm : '';
    const outcome = await removal.remove({ ownerId: idOf(req), requestedBy: userOf(req).id, confirm });
    if (!outcome.ok) return res.status(outcome.refusal.status).json(outcome.refusal);
    return res.status(202).json({ state: outcome.state });
  }));

  return router;
}
