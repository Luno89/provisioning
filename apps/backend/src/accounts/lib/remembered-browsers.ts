import crypto from 'crypto';

export interface RememberedBrowser {
  id: string;
  ownerId: string;
  account: string;
  expiresAt: Date;
}

export const REMEMBERED_SECONDS = 365 * 24 * 60 * 60;

export const newBrowserSecret = (): string => crypto.randomBytes(32).toString('base64url');

export const browserIdOf = (secret: string): string => crypto.createHash('sha256').update(secret).digest('hex');

export const rememberedUntil = (now: Date): Date => new Date(now.getTime() + REMEMBERED_SECONDS * 1000);

export const stillRemembered = (browser: RememberedBrowser | undefined, now: Date): browser is RememberedBrowser =>
  Boolean(browser && browser.expiresAt.getTime() > now.getTime());
