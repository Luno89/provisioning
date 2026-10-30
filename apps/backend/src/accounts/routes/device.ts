import type { Request, Response } from 'express';
import { cookieNamed, DEVICE_COOKIE, DEVICE_SECONDS, deviceOf, deviceToken, type Auth, type SecretKey } from '../../platform/index.js';
import { proofFrom } from '../lib/second-factor.js';
import type { AuthService, Refusal, SignedInDevice } from '../services/AuthService.js';

export interface Devices {
  known(req: Request): SignedInDevice;
  remember(req: Request, res: Response, email: string): void;
  confirmed(req: Request, user: Parameters<AuthService['confirmProblem']>[0]): Promise<Refusal | undefined>;
}

export function devicesFor(deps: { auth: Pick<Auth, 'getCookie' | 'sessionCookieOptions'>; sessionKey: SecretKey; authService: Pick<AuthService, 'confirmProblem'> }): Devices {
  const deviceCookie = cookieNamed(DEVICE_COOKIE, deps.auth.sessionCookieOptions.secure);
  const known = (req: Request) => deviceOf(deps.auth.getCookie(req, deviceCookie), deps.sessionKey);
  return {
    known,
    remember: (req, res, email) => {
      const account = email.trim().toLowerCase();
      const held = known(req);
      res.cookie(deviceCookie, deviceToken(account, deps.sessionKey, held?.account === account ? held.id : undefined), { ...deps.auth.sessionCookieOptions, maxAge: DEVICE_SECONDS * 1000 });
    },
    confirmed: (req, user) => deps.authService.confirmProblem(user, proofFrom(req.body), known(req)),
  };
}
