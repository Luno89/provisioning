import type { Request, Response } from 'express';
import { cookieNamed, type AccessRevocations, type Auth, type KeptSession, type UserMetadata } from '../../platform/index.js';
import { proofFrom } from '../lib/second-factor.js';
import { browserIdOf, newBrowserSecret, REMEMBERED_SECONDS, rememberedUntil, stillRemembered } from '../lib/remembered-browsers.js';
import type { AuthService, Refusal, SignedInDevice } from '../services/AuthService.js';
import type { AccountsStore } from '../store.js';

export const DEVICE_COOKIE = 'device';

export interface Devices {
  known(req: Request): Promise<SignedInDevice>;
  remember(req: Request, res: Response, user: Pick<UserMetadata, 'id' | 'email'>): Promise<void>;
  kept(req: Request): Promise<KeptSession>;
  confirmed(req: Request, user: Parameters<AuthService['confirmProblem']>[0]): Promise<Refusal | undefined>;
}

export interface DevicesDeps {
  auth: Pick<Auth, 'getCookie' | 'sessionCookieOptions' | 'keptSession'>;
  store: Pick<AccountsStore, 'saveRememberedBrowser' | 'getRememberedBrowser' | 'forgetBrowsersOf'>;
  authService: Pick<AuthService, 'confirmProblem'>;
  revocations?: Pick<AccessRevocations, 'listen'> | undefined;
  now?: (() => Date) | undefined;
}

export function devicesFor(deps: DevicesDeps): Devices {
  const now = deps.now ?? (() => new Date());
  const deviceCookie = cookieNamed(DEVICE_COOKIE, deps.auth.sessionCookieOptions.secure);
  const held = async (req: Request) => {
    const secret = deps.auth.getCookie(req, deviceCookie);
    if (!secret) return undefined;
    const browser = await deps.store.getRememberedBrowser(browserIdOf(secret));
    return stillRemembered(browser, now()) ? { secret, browser } : undefined;
  };
  const known = async (req: Request): Promise<SignedInDevice> => {
    const found = await held(req);
    return found ? { account: found.browser.account, id: found.browser.id } : undefined;
  };
  deps.revocations?.listen((revoked) => deps.store.forgetBrowsersOf(revoked.personId, revoked.kept?.browser));
  return {
    known,
    remember: async (req, res, user) => {
      const account = user.email.trim().toLowerCase();
      const found = await held(req);
      const secret = found && found.browser.ownerId === user.id ? found.secret : newBrowserSecret();
      await deps.store.saveRememberedBrowser({ id: browserIdOf(secret), ownerId: user.id, account, expiresAt: rememberedUntil(now()) });
      res.cookie(deviceCookie, secret, { ...deps.auth.sessionCookieOptions, maxAge: REMEMBERED_SECONDS * 1000 });
    },
    kept: async (req) => ({ ...deps.auth.keptSession(req), browser: (await known(req))?.id }),
    confirmed: async (req, user) => deps.authService.confirmProblem(user, proofFrom(req.body), await known(req), req.ip),
  };
}
