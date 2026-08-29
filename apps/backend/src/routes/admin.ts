import { Router, type Request } from 'express';
import crypto from 'crypto';
import { asyncRoute } from '../middleware/async-route.js';
import { v4 as uuidv4 } from 'uuid';
import type { InviteMetadata } from '../lib/types.js';

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

  return router;
}
