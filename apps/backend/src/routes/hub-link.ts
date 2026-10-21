import crypto from 'node:crypto';
import { Router } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import { HUB_ROLES } from '../lib/hub.js';
import type { ProjectInviteService } from '../services/ProjectInviteService.js';

const sameHash = (a: string, b: string): boolean => {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
};

export function hubLinkRouter(deps: { invites: ProjectInviteService; credentialHash?: string | undefined; hash: (secret: string) => string }): Router {
  const router = Router();

  router.post('/invite', asyncRoute(async (req, res) => {
    const given = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!deps.credentialHash || !given || !sameHash(deps.hash(given), deps.credentialHash)) return res.status(401).json({ error: 'only this root\'s hub sends project invites' });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fields = ['email', 'inviterId', 'inviterEmail', 'projectName', 'role', 'join'] as const;
    if (fields.some((field) => typeof body[field] !== 'string' || !(body[field] as string).trim())) return res.status(400).json({ error: `an invite names ${fields.join(', ')}` });
    if (!HUB_ROLES.includes(body.role as never)) return res.status(400).json({ error: 'that is not a role on a project' });
    res.status(201).json(await deps.invites.send(body as never));
  }));

  router.get('/invitation', asyncRoute(async (req, res) => {
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const found = code ? await deps.invites.invitation(code) : undefined;
    if (!found) return res.status(404).json({ error: 'This invite does not exist; ask for a new one.' });
    res.json(found);
  }));

  return router;
}
