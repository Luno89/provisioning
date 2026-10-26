import { Router, type Request } from 'express';
import crypto from 'crypto';
import { asyncRoute, inviteCodeHash, inviteExpiry, inviteView, newInviteCode, type InviteMetadata } from '../../platform/index.js';
import type { AccountRemovalService } from '../services/AccountRemovalService.js';
import { FIRST_ADMIN_INVITE } from '../store.js';

const idOf = (req: Request): string => String(req.params.id ?? '');

const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

export function adminRouter(deps: Record<string, any>): Router {
  const { db, requireAdmin } = deps;
  const router = Router();

  router.get('/invites', requireAdmin, async (_req, res) => {
    const now = new Date();
    res.json((await db.accounts.getInvites() as InviteMetadata[]).filter((invite) => !invite.project && invite.id !== FIRST_ADMIN_INVITE).map((invite) => inviteView(invite, now)));
  });

  router.post('/invites', requireAdmin, async (req, res) => {
    const now = new Date();
    const code = newInviteCode();
    const invite: InviteMetadata = {
      id: crypto.randomUUID(),
      codeHash: inviteCodeHash(code),
      createdBy: userOf(req).id,
      createdAt: now.toISOString(),
      expiresAt: inviteExpiry(now),
    };
    await db.accounts.saveInvite(invite);
    res.status(201).json({ ...inviteView(invite, now), code });
  });

  const removal = deps.removal as AccountRemovalService | undefined;
  const ELSEWHERE = 'Accounts cannot be removed here';

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
