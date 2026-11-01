import { Router, type Request, type RequestHandler, type Response } from 'express';
import crypto from 'crypto';
import { asyncRoute, inviteCodeHash, inviteExpiry, inviteView, newInviteCode, principalFrom, type Database, type InviteMetadata } from '../../platform/index.js';
import type { AccountRemovalService } from '../services/AccountRemovalService.js';
import type { ProjectInviteLimitsService } from '../services/ProjectInviteLimitsService.js';
import { FIRST_ADMIN_INVITE } from '../store.js';

const idOf = (req: Request): string => String(req.params.id ?? '');

const userOf = (req: Request): { id: string; email: string } =>
  (req as unknown as { user: { id: string; email: string } }).user;

export interface AdminRouterDeps {
  db: { accounts: Pick<Database['accounts'], 'getInvites' | 'saveInvite'> };
  operatorOnly: RequestHandler;
  inviteLimits: Pick<ProjectInviteLimitsService, 'overview' | 'setLimits' | 'setOwn'>;
  removal?: Pick<AccountRemovalService, 'people' | 'preview' | 'remove'> | undefined;
}

const bodyOf = (req: Request): Record<string, unknown> => (req.body ?? {}) as Record<string, unknown>;

export function adminRouter(deps: AdminRouterDeps): Router {
  const { db, operatorOnly, inviteLimits, removal } = deps;
  const router = Router();

  router.get('/invites', operatorOnly, asyncRoute(async (_req, res) => {
    const now = new Date();
    res.json((await db.accounts.getInvites()).filter((invite) => !invite.project && invite.id !== FIRST_ADMIN_INVITE).map((invite) => inviteView(invite, now)));
  }));

  router.post('/invites', operatorOnly, asyncRoute(async (req, res) => {
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
  }));

  const answered = <T>(res: Response, outcome: { ok: true; value: T } | { ok: false; status: number; why: string }) =>
    (outcome.ok ? res.json(outcome.value) : res.status(outcome.status).json({ error: outcome.why }));

  router.get('/project-invites', operatorOnly, asyncRoute(async (_req, res) => res.json(await inviteLimits.overview())));
  router.put('/project-invites', operatorOnly, asyncRoute(async (req, res) => answered(res, await inviteLimits.setLimits({ accounts: bodyOf(req).accounts, perHour: bodyOf(req).perHour }))));
  router.put('/people/:id/project-invites', operatorOnly, asyncRoute(async (req, res) => answered(res, await inviteLimits.setOwn(idOf(req), bodyOf(req).accounts))));

  const ELSEWHERE = 'Accounts cannot be removed here';

  router.get('/people', operatorOnly, asyncRoute(async (_req, res) => {
    if (!removal) return res.status(404).json({ error: ELSEWHERE });
    return res.json({ people: await removal.people() });
  }));

  router.get('/people/:id/removal', operatorOnly, asyncRoute(async (req, res) => {
    if (!removal) return res.status(404).json({ error: ELSEWHERE });
    const preview = await removal.preview(idOf(req));
    if (!preview) return res.status(404).json({ error: 'There is no such account' });
    return res.json(preview);
  }));

  router.delete('/people/:id', operatorOnly, asyncRoute(async (req, res) => {
    if (!removal) return res.status(404).json({ error: ELSEWHERE });
    const { confirm: given } = bodyOf(req);
    const confirm = typeof given === 'string' ? given : '';
    const outcome = await removal.remove({ ownerId: idOf(req), requestedBy: userOf(req).id, confirm }, principalFrom(req));
    if (!outcome.ok) return res.status(outcome.refusal.status).json(outcome.refusal);
    return res.status(202).json({ state: outcome.state });
  }));

  return router;
}
