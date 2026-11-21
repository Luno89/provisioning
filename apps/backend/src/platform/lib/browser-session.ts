import type { Claim } from './permissions.js';

export interface BrowserPerson {
  sub: string;
  email: string;
  claims: Claim[];
  sessionAt: number;
  accessExp: number;
  rootSid?: string | undefined;
  tokens: { access: string; refresh: string; id: string };
}

export interface SignInStarted {
  verifier: string;
  state: string;
  nonce: string;
  next?: string | undefined;
}

export interface PersonThroughRoot {
  fresh(person: BrowserPerson): Promise<BrowserPerson | 'kept' | 'ended'>;
  end(person: BrowserPerson): Promise<string>;
}

export type BrowserSessionsOf = { sub: string } | { rootSid: string };

export const BROWSER_SESSION_COOKIE = 'koala_sid';

export const BROWSER_SESSION_SECONDS = 14 * 24 * 60 * 60;

export interface AccountSession {
  sub: string;
  sessionAt: number;
}

export interface HeldSession {
  person?: Pick<BrowserPerson, 'sub' | 'rootSid'> | undefined;
  account?: AccountSession | undefined;
}

export const heldBy = (held: HeldSession, of: BrowserSessionsOf): boolean =>
  'sub' in of ? held.person?.sub === of.sub || held.account?.sub === of.sub : held.person !== undefined && held.person.rootSid === of.rootSid;

declare module 'express-session' {
  interface SessionData {
    person: BrowserPerson;
    account: AccountSession;
    signingIn: SignInStarted;
  }
}
