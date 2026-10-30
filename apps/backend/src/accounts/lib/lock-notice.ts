import { LOCKOUT } from '../../platform/lib/http-limits.js';

export const LOCKED_MINUTES = Math.round(LOCKOUT.forMs / 60_000);

export interface LockNotice {
  mail: { subject: string; text: string };
  push: { title: string; body: string; path: string; tag: string };
}

export function lockNotice(address: string | undefined, tries = LOCKOUT.after, minutes = LOCKED_MINUTES): LockNotice {
  const from = address ? `from ${address}` : 'from an address we could not tell';
  const what = `Someone tried your Koala password ${tries} times ${from}, so your account is locked to other browsers for ${minutes} minutes. A browser you have signed in on before can still sign in.`;
  const advice = 'If it was not you, you may want to change your password: Settings → Password.';
  return {
    mail: { subject: 'Your Koala account is locked to other browsers', text: `${what}\n\n${advice}` },
    push: { title: 'Your account is locked to other browsers', body: `${what} ${advice}`, path: '/#/settings', tag: 'account-locked' },
  };
}
