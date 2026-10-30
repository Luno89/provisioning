export interface RateLimitRule {
  name: string;
  paths: readonly string[];
  prefixes: readonly string[];
  windowMs: number;
  max: number;
  said: string;
  countsOnlyFailures: boolean;
}

const MINUTES = 60_000;

export const JSON_LIMITS = { signedIn: '20mb', signedOut: '256kb' } as const;

const LARGE_WITHOUT_A_SESSION = ['/api/checks/scripted/', '/api/hub-instance/'];

export function jsonLimitFor(path: string, signedIn: boolean): keyof typeof JSON_LIMITS {
  return signedIn || LARGE_WITHOUT_A_SESSION.some((prefix) => path.startsWith(prefix)) ? 'signedIn' : 'signedOut';
}

export const RATE_LIMITS: readonly RateLimitRule[] = [
  {
    name: 'sign-in',
    paths: ['/auth/login', '/auth/register', '/auth/register/verify', '/auth/register/resend', '/auth/2fa/verify', '/auth/handoff', '/auth/sign-in', '/auth/password/reset'],
    prefixes: ['/auth/provider/'],
    windowMs: 15 * MINUTES,
    max: 30,
    said: 'Too many sign-in attempts from this address; wait fifteen minutes and try again.',
    countsOnlyFailures: true,
  },
  {
    name: 'password-reset',
    paths: ['/auth/password/forgot', '/auth/password/forgot/resend'],
    prefixes: [],
    windowMs: 15 * MINUTES,
    max: 10,
    said: 'Too many password resets asked from this address; wait fifteen minutes and try again.',
    countsOnlyFailures: false,
  },
  {
    name: 'joining',
    paths: ['/hub-link/invite', '/hub-link/invitation', '/machines/join', '/instances/join', '/instances/hub-token'],
    prefixes: ['/hub/invitations/'],
    windowMs: 15 * MINUTES,
    max: 60,
    said: 'Too many requests from this address; wait a few minutes and try again.',
    countsOnlyFailures: true,
  },
  {
    name: 'share-links',
    paths: [],
    prefixes: ['/share/'],
    windowMs: 15 * MINUTES,
    max: 300,
    said: 'This link was opened too many times from this address; wait a few minutes and try again.',
    countsOnlyFailures: false,
  },
];

export const CSP_REPORT_LIMIT = { windowMs: 15 * MINUTES, max: 120 } as const;

const asRouted = (path: string): string => path.toLowerCase().replace(/\/{2,}/g, '/').replace(/(.)\/+$/, '$1');

export const ruleFor = (path: string): RateLimitRule | undefined => {
  const routed = asRouted(path);
  return RATE_LIMITS.find((rule) => rule.paths.includes(routed) || rule.prefixes.some((prefix) => routed.startsWith(prefix)));
};

export interface SignInAttempts {
  failures: number[];
}

export interface LockoutRule {
  after: number;
  windowMs: number;
  forMs: number;
}

export const LOCKOUT: LockoutRule = { after: 10, windowMs: 15 * MINUTES, forMs: 15 * MINUTES };

export const TWO_FACTOR_LOCKOUT: LockoutRule = { after: 5, windowMs: 15 * MINUTES, forMs: 15 * MINUTES };

export function lockedUntil(attempts: SignInAttempts | undefined, now: number, rule: LockoutRule = LOCKOUT): number | undefined {
  if (!attempts) return undefined;
  const recent = attempts.failures.filter((at) => now - at < rule.windowMs);
  if (recent.length < rule.after) return undefined;
  const last = Math.max(...recent);
  return last + rule.forMs > now ? last + rule.forMs : undefined;
}

export const afterFailure = (attempts: SignInAttempts | undefined, now: number, rule: LockoutRule = LOCKOUT): SignInAttempts =>
  ({ failures: [...(attempts?.failures ?? []).filter((at) => now - at < rule.windowMs), now] });

export const attemptsKeptUntil = (attempts: SignInAttempts, rule: LockoutRule = LOCKOUT): number =>
  Math.max(0, ...attempts.failures) + Math.max(rule.windowMs, rule.forMs);

export const justLocked = (before: SignInAttempts | undefined, after: SignInAttempts, now: number, rule: LockoutRule = LOCKOUT): boolean =>
  lockedUntil(before, now, rule) === undefined && lockedUntil(after, now, rule) !== undefined;

export const lockedSaid = (until: number, now: number): string => {
  const minutes = Math.max(1, Math.ceil((until - now) / MINUTES));
  return `Too many failed sign-ins for this account; try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
};

export const twoFactorLockedSaid = (until: number, now: number): string => {
  const minutes = Math.max(1, Math.ceil((until - now) / MINUTES));
  return `Too many wrong codes for this account; codes are refused for ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
};

export const ACCOUNT_KEY = 'account:';

export const attemptsKeyFor = (account: string, device: { account: string; id: string } | undefined): string =>
  device && device.account === account ? `device:${device.id}` : `${ACCOUNT_KEY}${account}`;

export const twoFactorKeyFor = (userId: string): string => `two-factor:${userId}`;

export const CONFIRM_CODES: LockoutRule = { after: 5, windowMs: 15 * MINUTES, forMs: 15 * MINUTES };

export const confirmCodesKeyFor = (userId: string): string => `confirm-codes:${userId}`;

export function fullUntil(sent: SignInAttempts | undefined, now: number, rule: LockoutRule = CONFIRM_CODES): number | undefined {
  const recent = (sent?.failures ?? []).filter((at) => now - at < rule.windowMs);
  return recent.length < rule.after ? undefined : Math.min(...recent) + rule.windowMs;
}

export const confirmCodesSaid = (until: number, now: number, rule: LockoutRule = CONFIRM_CODES): string => {
  const minutes = Math.max(1, Math.ceil((until - now) / MINUTES));
  return `Koala has sent you ${rule.after} confirmation codes in the last ${Math.round(rule.windowMs / MINUTES)} minutes; ask for another in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
};
