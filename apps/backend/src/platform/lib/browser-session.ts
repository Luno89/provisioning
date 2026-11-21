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

export const heldBy = (person: Pick<BrowserPerson, 'sub' | 'rootSid'> | undefined, of: BrowserSessionsOf): boolean =>
  person !== undefined && ('sub' in of ? person.sub === of.sub : person.rootSid === of.rootSid);

declare module 'express-session' {
  interface SessionData {
    person: BrowserPerson;
    signingIn: SignInStarted;
  }
}
