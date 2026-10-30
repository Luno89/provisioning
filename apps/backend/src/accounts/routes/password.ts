import { Router, type Request, type Response } from 'express';
import { asyncRoute, sessionToken, type Auth, type SecretKey, type UserMetadata } from '../../platform/index.js';
import type { Answered, PasswordService } from '../services/PasswordService.js';
import type { Devices } from './device.js';

export interface PasswordRouterDeps {
  passwords: Pick<PasswordService, 'forgot' | 'resend' | 'reset' | 'change'>;
  auth: Pick<Auth, 'setSessionCookie'>;
  devices: Pick<Devices, 'known'>;
  sessionKey: SecretKey;
}

const answer = <T extends object>(res: Response, outcome: Answered<T>, shape: (value: T) => unknown) =>
  (outcome.ok ? res.json(shape(outcome)) : res.status(outcome.status).json({ error: outcome.error }));

export function passwordRouter(deps: PasswordRouterDeps): Router {
  const router = Router();

  router.post('/forgot', asyncRoute(async (req, res) => {
    answer(res, await deps.passwords.forgot(req.body?.email), ({ reset, devCode }) => ({ reset, ...(devCode ? { devCode } : {}) }));
  }));

  router.post('/forgot/resend', asyncRoute(async (req, res) => {
    answer(res, await deps.passwords.resend(req.body?.id), ({ reset, devCode }) => ({ reset, ...(devCode ? { devCode } : {}) }));
  }));

  router.post('/reset', asyncRoute(async (req, res) => {
    answer(res, await deps.passwords.reset({ id: req.body?.id, code: req.body?.code, password: req.body?.password }), ({ email }) => ({ reset: true, email }));
  }));

  router.post('/', asyncRoute(async (req: Request, res: Response) => {
    const user = (req as { user?: UserMetadata }).user;
    if (!user) return res.status(401).json({ error: 'Sign in first' });
    const changed = await deps.passwords.change(user, { password: req.body?.password, current: req.body?.current, code: req.body?.code }, deps.devices.known(req), req.ip);
    if (changed.ok) deps.auth.setSessionCookie(res, sessionToken(changed.user, deps.sessionKey), req);
    return answer(res, changed, () => ({ changed: true }));
  }));

  return router;
}
