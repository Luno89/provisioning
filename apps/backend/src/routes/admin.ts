import { Router, type Request } from 'express';
import crypto from 'crypto';
import { asyncRoute } from '../middleware/async-route.js';
import { v4 as uuidv4 } from 'uuid';
import type { InviteMetadata } from '../lib/types.js';

/** The `:id` from the path, narrowed once — Express types `req.params` loosely inside asyncRoute. */
const idOf = (req: Request): string => String(req.params.id ?? '');

/** The user `requireAuth` put on the request. */
const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

/**
 * Invite codes. Admin-only — `requireAdmin` is applied per route in bootstrap, not here.
 */
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

  return router;
}
