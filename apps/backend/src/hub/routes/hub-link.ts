import crypto from 'node:crypto';
import { Router } from 'express';
import { asyncRoute } from '../../platform/index.js';
import { HUB_ROLES } from '../lib/hub.js';
import { publicJwkShaped, type SignInKey } from '../../instances/index.js';
import type { ProjectInviteService } from '../services/ProjectInviteService.js';

const sameHash = (a: string, b: string): boolean => {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
};

export function hubLinkRouter(deps: {
  invites: ProjectInviteService;
  credentialHash?: string | undefined;
  hash: (secret: string) => string;
  signInKeys?: { get(): Promise<SignInKey | undefined>; save(key: SignInKey): Promise<void> } | undefined;
  serviceCaller?: ((token: string) => Promise<{ clientId: string; kind: 'instance' | 'hub' } | undefined>) | undefined;
  personAtHub?: ((token: string) => Promise<string | undefined>) | undefined;
  people: { getUserById(id: string): Promise<{ id: string; email: string; removal?: unknown } | undefined> };
}): Router {
  const router = Router();
  const bearer = (req: { headers: { authorization?: string | undefined } }) => String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const credentialed = (given: string) => Boolean(deps.credentialHash && given && sameHash(deps.hash(given), deps.credentialHash));

  router.put('/sign-in-key', asyncRoute(async (req, res) => {
    if (!credentialed(bearer(req)) || !deps.signInKeys) return res.status(401).json({ error: 'only this root\'s hub names its sign-in key' });
    const jwk = ((req.body ?? {}) as { jwk?: unknown }).jwk;
    if (!publicJwkShaped(jwk)) return res.status(400).json({ error: 'send the hub\'s sign-in key as an Ed25519 public JWK with its kid' });
    const held = await deps.signInKeys.get();
    const since = held?.jwk.kid === jwk.kid ? held.since : new Date().toISOString();
    await deps.signInKeys.save({ jwk: { kty: 'OKP', crv: 'Ed25519', x: jwk.x, kid: jwk.kid }, since });
    res.json({ since });
  }));

  router.post('/invite', asyncRoute(async (req, res) => {
    const given = bearer(req);
    const vouched = !credentialed(given) && given ? (await deps.serviceCaller?.(given))?.kind === 'hub' : false;
    if (!credentialed(given) && !vouched) return res.status(401).json({ error: 'only this root\'s hub sends project invites' });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fields = ['email', 'projectName', 'role', 'join', 'inviterToken'] as const;
    if (fields.some((field) => typeof body[field] !== 'string' || !(body[field] as string).trim())) return res.status(400).json({ error: `an invite names ${fields.join(', ')}` });
    if (!HUB_ROLES.includes(body.role as never)) return res.status(400).json({ error: 'that is not a role on a project' });
    const inviterId = await deps.personAtHub?.(body.inviterToken as string);
    const inviter = inviterId ? await deps.people.getUserById(inviterId) : undefined;
    if (!inviter || inviter.removal) return res.status(403).json({ error: 'root does not know who is inviting: the invite carries no sign-in root gave them at the hub' });
    const { email, projectName, role, join } = body as Record<(typeof fields)[number], string>;
    const sent = await deps.invites.send({ email, projectName, role, join, inviterId: inviter.id, inviterEmail: inviter.email });
    if ('refused' in sent) return res.status(429).json({ error: sent.refused });
    res.status(201).json(sent);
  }));

  router.get('/invitation', asyncRoute(async (req, res) => {
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const found = code ? await deps.invites.invitation(code) : undefined;
    if (!found) return res.status(404).json({ error: 'This invite does not exist; ask for a new one.' });
    res.json(found);
  }));

  return router;
}
